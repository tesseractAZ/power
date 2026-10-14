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
 *   C-xlii…C-lvi   the drain to the just-in-time force-charge start, the in-progress hour,
 *                  the after-the-fact pushes, the no-basis headline
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
    find: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP50W!) / o.dischargeEff)) / 1000));',
    to: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP90W) / o.dischargeEff)) / 1000)); /* MUTANT */',
    why: 'The "expected" start collapses onto the worst case again and the 10-12 plan says ~62 kWh expected.',
  },
  {
    id: 'C-ii. ★★ the expected carry is not floored at the reserve',
    file: NCA,
    find: '  const floor = Math.min(Math.max(0, o.reserveKwh), pack);\n  const byHour = hoursByEpoch(o.hours);\n  for (let slot',
    to: '  const floor = 0; /* MUTANT */\n  const byHour = hoursByEpoch(o.hours);\n  for (let slot',
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
    find: '    const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;\n    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w *',
    to: '    const pv = h.pvP10W; /* MUTANT */\n    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w *',
    why: 'An afternoon plan understates the sun the pool expects before the window and overstates the buy.',
  },
  {
    id: 'C-v. ★★ an hour without a P50 load counts as a basis',
    file: NCA,
    find: '  return h != null && h.loadP50W != null && Number.isFinite(h.loadP50W) ? h : null;',
    to: '  return h ?? null; /* MUTANT */',
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
    find: '  out.buyKwh = round2(Math.min(liftKwh, deliverableKwh) / o.legEff);',
    to: '  out.buyKwh = round2(liftKwh / o.legEff); /* MUTANT */',
    why: 'Friday\'s one-hour window states a draw it cannot pass.',
  },
  {
    id: 'C-xii. ★★ the expected buy can be negative',
    file: NCA,
    find: '  let liftKwh = Math.max(0, Math.min(levelKwh, reserveKwh) - o.startKwh);',
    to: '  let liftKwh = Math.min(levelKwh, reserveKwh) - o.startKwh; /* MUTANT */',
    why: 'A pool opening above the reserve states a negative reserve leg, and a smaller (or negative) purchase.',
  },
  {
    id: 'C-xiii. ★★ the expected buy is pack-side (no charge leg)',
    file: NCA,
    find: '  out.buyKwh = round2(Math.min(liftKwh, deliverableKwh) / o.legEff);',
    to: '  out.buyKwh = round2(Math.min(liftKwh, deliverableKwh)); /* MUTANT */',
    why: 'The meter-side figure loses the ~7% charge-leg loss and no longer compares with buy_kwh or delivered_kwh.',
  },
  {
    id: 'C-xiv. ★★ a night that does not arm states a positive expected buy',
    file: NCA,
    find: '    : { buyKwh: 0, levelPct: null };',
    to: '    : expectedBuyFromPlan({ setpointSocPct, costCeilingSocPct, forceChargeEligible: inputs.forceChargeEligible === true, startKwh: expectedStartKwh, deliverableKwh: expectedDeliverableKwh, fullKwh, legEff, window: { hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, dischargeEff, chargeCapKw, envelopeKw } }); /* MUTANT */',
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
    find: '      return start < level\n',
    to: '      return start >= level /* MUTANT */\n',
    why: '"tonight\'s write charges it to 50%" of a pool at 66% — the zero expected buy loses its reason.',
  },
  {
    id: 'C-xx. ★ the rationale stops naming the force-charge leg',
    file: NCA,
    find: '    if (start < writtenPct) return `, and tonight\'s write charges it ${to} (the ${writtenPct}% reserve, then force-charge from ~${at})${asFar}`;',
    to: '    if (start < writtenPct) return `, and tonight\'s write charges it ${to}${asFar}`; /* MUTANT */',
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
  // ── the drain to the just-in-time start ──
  {
    id: 'C-xlii. ★★★ the force-charge leg starts from the window open again',
    file: NCA,
    find: '    if (jit.startMs != null) liftKwh += Math.max(0, levelKwh - jit.packKwh);',
    to: '    liftKwh += Math.max(0, levelKwh - Math.max(o.startKwh, reserveKwh)); /* MUTANT */',
    why: 'The drain the just-in-time start buys back is dropped: a 74% evening states ~14 kWh for a ~22 kWh night, a 96% one ~0 for ~3.5.',
  },
  {
    id: 'C-xliii. ★★★ the walk does not drain the pool before the start',
    file: NCA,
    find: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + ((pv - loadW / o.dischargeEff) / 1000) * (EXPECTED_JIT_STEP_MS / HOUR_MS)));',
    to: '    pack = Math.max(floor, Math.min(o.fullKwh, pack)); /* MUTANT */',
    why: 'The pool sits at its window-open level until the start: the same understatement by another road.',
  },
  {
    id: 'C-xliv. ★★ the walk drains through the written reserve',
    file: NCA,
    find: '  const floor = Math.min(Math.max(0, o.reserveKwh), pack);\n  const lastStartMs',
    to: '  const floor = 0; /* MUTANT */\n  const lastStartMs',
    why: 'With the grid present the SHP2 holds the 50% reserve; a heavy house load would be bought back from below it.',
  },
  {
    id: 'C-xlv. ★★ the walk starts a force-charge inside the last 20 minutes',
    file: NCA,
    find: '  const lastStartMs = o.windowEndMs - FORCE_CHARGE_MIN_RUN_MS;',
    to: '  const lastStartMs = o.windowEndMs; /* MUTANT */',
    why: 'decideForceCharge starts nothing that late; a pool drifting under its stop at 04:43 would state a buy that never happens.',
  },
  {
    id: 'C-xlvi. ★★ the walk starts a force-charge at or above the stop',
    file: NCA,
    find: '    if (poolPct < stopPct) {',
    to: '    if (true) { /* MUTANT */',
    why: 'With an EV predicted the start is due early, but decideForceCharge starts nothing above the stop — the walk would start from 90%.',
  },
  {
    id: 'C-xlvii. ★★ the walk ignores the predicted EV the live start counts',
    file: NCA,
    find: '      if (t >= forceChargeStartAtMs(o.windowEndMs, o.ceilingPct, poolPct, o.fullKwh, rateKw, evDisplacedKwh)) {',
    to: '      if (t >= forceChargeStartAtMs(o.windowEndMs, o.ceilingPct, poolPct, o.fullKwh, rateKw, null)) { /* MUTANT */',
    why: 'index.ts times the live start with the plan\'s EV displacement; without it the walk starts later and states more drain than the write allows.',
  },
  {
    id: 'C-xlviii. ★★ the walk times the start with the fixed plan rate',
    file: NCA,
    find: '      const rateKw = o.envelopeKw == null ? null : p50ChargeRateKw(loadW, o.chargeCapKw, o.envelopeKw) * o.legEff;',
    to: '      const rateKw = null; /* MUTANT */',
    why: 'The live start reads the grid cap less the house (forceChargeRateKw); the 10 kW fallback starts ~30 min early and understates the drain.',
  },
  {
    id: 'C-xlix. ★★ the rationale names the window-open level as the pool at the start',
    file: NCA,
    find: 'the house should draw it to ~${expected.forceChargeFromPct}% before the just-in-time force-charge',
    to: 'the house should draw it to ~${start}% /* MUTANT */ before the just-in-time force-charge',
    why: 'The sentence that explains the larger figure says the pool is not drawn down at all.',
  },
  {
    id: 'C-l. ★ a window-bound buy reads as reaching the level',
    file: NCA,
    find: '  if (liftKwh > deliverableKwh + 1e-9) out.deliverableBound = true;',
    to: '  /* MUTANT */',
    why: 'Friday\'s rationale says the write charges the pool to 80% in a window that passes a fraction of it.',
  },
  // ── the in-progress hour ──
  {
    id: 'C-li. ★★ the in-progress hour missing from the band drops the carry again',
    file: NCA,
    find: '  const h = byHour.get(key) ?? (slotTs < fromMs ? byHour.get(key + 1) : undefined);',
    to: '  const h = byHour.get(key); /* MUTANT */',
    why: 'At 21:05 with the band starting at 22:00 the plan states no expected figure (or, as before the review, up to ~3 kWh too little).',
  },
  {
    id: 'C-lii. ★ any missing hour is stood in for by the next',
    file: NCA,
    find: '  const h = byHour.get(key) ?? (slotTs < fromMs ? byHour.get(key + 1) : undefined);',
    to: '  const h = byHour.get(key) ?? byHour.get(key + 1); /* MUTANT */',
    why: 'A gap inside the span is papered over with a neighbour\'s load instead of voiding a figure with no basis.',
  },
  {
    id: 'C-liii. ★ the window bound skips a missing hour',
    file: NCA,
    find: '    if (h == null) return null;\n    kwh += p50ChargeRateKw(',
    to: '    if (h == null) continue; /* MUTANT */\n    kwh += p50ChargeRateKw(',
    why: 'A window hour with no basis silently shrinks the bound, capping the expected buy with no disclosure.',
  },
  // ── the after-the-fact pushes ──
  {
    id: 'C-liv. ★★★ the morning summary calls the worst case the planned buy',
    file: IDX,
    find: '        + `(planned buy ${armedBuyPhrase(armedExpectedBuyKwh(state.day), state.buyKwh)}) and restored to ${action.restorePct}%. `',
    to: '        + `(planned buy ~${state.buyKwh ?? \'—\'} kWh) and restored to ${action.restorePct}%. ` /* MUTANT */',
    why: 'The evening says ~35 kWh, the morning "planned buy ~64 kWh" — delivery reads as half the plan.',
  },
  {
    id: 'C-lv. ★★ the apply-failure push calls the worst case the planned buy',
    file: IDX,
    find: '    const buyPhrase = armedBuyPhrase(armedExpectedBuyKwh(state.day), state.buyKwh);',
    to: '    const buyPhrase = `~${state.buyKwh ?? \'—\'} kWh`; /* MUTANT */',
    why: 'The forfeited buy is stated as the worst case, unlabelled.',
  },
  {
    id: 'C-lv-b. ★★ the pushes never read the armed day\'s expected figure',
    file: IDX,
    find: '    return ledgerExpectedBuyKwh(recorder.readNightLedger(14), day);',
    to: '    return null; /* MUTANT */',
    why: 'Every after-the-fact push falls back to the worst case though the plan row holds the expected figure.',
  },
  {
    id: 'C-lv-c. ★ the ledger lookup reads another night\'s row',
    file: NCA,
    find: '  const v = rows.find((r) => r.plan_date === day)?.expected_buy_kwh;',
    to: '  const v = rows[0]?.expected_buy_kwh; /* MUTANT */',
    why: 'The morning push states the expected figure of the oldest row in the fortnight, not the armed night\'s.',
  },
  {
    id: 'C-lv-d. ★★ with no expected figure the worst case is stated unlabelled',
    file: NCA,
    find: '  if (expectedKwh == null || !Number.isFinite(expectedKwh)) return `${worst}, the worst case the plan was sized on`;',
    to: '  if (expectedKwh == null || !Number.isFinite(expectedKwh)) return worst; /* MUTANT */',
    why: 'An older plan row brings back "planned buy ~64 kWh" with nothing saying it is the worst case.',
  },
  // ── the no-basis headline ──
  {
    id: 'C-lvi. ★★ the no-basis headline states the raw figure and drops the calibration',
    file: NCA,
    find: '    ? `Buy ~${round1(buyKwhDebiased)} kWh overnight${calNote}`',
    to: '    ? `Buy ~${round1(buyKwh)} kWh overnight` /* MUTANT */',
    why: 'With a learned de-bias and no median basis the announced figure loses its calibration, silently.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22c', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
