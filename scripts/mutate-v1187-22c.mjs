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
 *   C-lvii…C-lxxi  what is spoken and pushed states the charge the write arms — the level and
 *                  the expected draw, no kWh without one — never the worst case, which only the
 *                  rationale and the card name, as the sizing basis; the worst-case entity's
 *                  name; the in-progress hour's EV in the just-in-time walk
 *   C-lxxii…C-xcvii no line presents a sizing figure as the outcome: the worst-case arrival is
 *                  never "expected"; "toward" on a window-bound night on every surface; the
 *                  window's time on the speakers; which hold it is, on the trough it was decided
 *                  on, labelled; a refused arm pushes no level or draw; the morning push names
 *                  the force-charge level and does not call a cancel or an abort completed; the
 *                  card's and the arrival entity's labels
 *   C-xcviii…C-cxxxviii (recheck) what the system will actually do: a night expected to charge
 *                  nothing says the reserve is held and no charge is expected, on every surface;
 *                  the morning push states what the force-charge did, from the actuation record;
 *                  the force-charge clause says when it is expected to start and that it may not
 *                  get there; one floor+cushion line (the one the plan is sized on); the card
 *                  leads with a refused arm
 *   C-cxxxix…C-clxix (recheck 3) the level a force-charge night with no start expected reaches
 *                  (the reserve); whether force-charge rode the night, stamped at arm time and read
 *                  by the morning push, which names the expected figure only beside the legs it
 *                  counts; a partial ON failure; an arm no announcement delivered and a refusal a
 *                  missed evening keeps; a refused hold worded as a hold, "the write" in auto
 *                  mode; no EV note on a no-charge night; the ON-failure push names the stop
 *   C-clxx…C-clxxiv  (final review) a spoken detail is cut at a sentence end, never at a decimal
 *                  point, and otherwise between words (a figure is never split); the peak-grid-draw
 *                  cost is stated as the on-peak spend it is, not a premium over overnight
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
const CARD = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');
const TTS = resolve(REPO, 'server/src/ttsService.ts');
const PGD = resolve(REPO, 'server/src/peakGridDraw.ts');
const SUBSET = [
  'test/nightChargeExpectedBuy.test.ts',
  'test/ledgerExpectedBuy.test.ts',
  'test/buyDebiasCalibration.test.ts',
  'test/nightChargeMqtt.test.ts',
  'test/nightForceCharge.test.ts',
  'test/announcePathIntegrity.test.ts',
  'test/spokenDetailCut.test.ts',
];

const MUTANTS = [
  // ── the expected carry ──
  {
    id: 'C-i. ★★★ the expected carry drains the P90 load',
    file: NCA,
    find: '    pack = Math.max(slotFloor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP50W!) / o.dischargeEff)) / 1000));',
    to: '    pack = Math.max(slotFloor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP90W) / o.dischargeEff)) / 1000)); /* MUTANT */',
    why: 'The "expected" start collapses onto the worst case again and the 10-12 plan says ~62 kWh expected.',
  },
  {
    id: 'C-ii. ★★ the expected carry is not floored at the reserve',
    file: NCA,
    find: '  const floor = Math.min(Math.max(0, o.reserveKwh), pack);\n  const hold = o.hold != null',
    to: '  const floor = 0; /* MUTANT */\n  const hold = o.hold != null',
    why: 'A grid-present carry drains through the reserve the SHP2 holds, overstating the expected buy on a heavy evening.',
  },
  {
    id: 'C-iii. ★★ the expected carry counts the whole current hour',
    file: NCA,
    find: '      startKwh: socNowKwh, fullKwh, reserveKwh, dischargeEff, hours: horizon, fromMs: nowMs, toMs: windowStart,',
    to: '      startKwh: socNowKwh, fullKwh, reserveKwh, dischargeEff, hours: horizon, fromMs: simFromMs, toMs: windowStart, /* MUTANT */',
    why: 'The 21:00-21:30 drain the SoC reading already reflects is charged a second time (the sizing\'s conservative choice, wrong for an expectation).',
  },
  {
    id: 'C-iv. ★ the expected carry reads P10 PV',
    file: NCA,
    find: '    const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;\n    const slotFloor',
    to: '    const pv = h.pvP10W; /* MUTANT */\n    const slotFloor',
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
    // v1.187.22 — re-pointed: the headline is the charge the write arms.
    id: 'C-xvi. ★★★ the headline states the worst case again',
    file: NCA,
    find: "    + `${expected.buyKwh == null ? '' : `: ~${round1(expected.buyKwh)} kWh expected`}.`;",
    to: "    + `${expected.buyKwh == null ? '' : `: ~${round1(buyKwhDebiased)} kWh expected`}.`; /* MUTANT */",
    why: 'The 10-12 headline leads with ~64 kWh again, now called "expected".',
  },
  {
    // v1.187.22 — re-pointed at the sizing sentence, the one place it is named.
    id: 'C-xvii. ★★ the worst case named is the raw figure, not the announced (de-biased) one',
    file: NCA,
    find: '  const sizingNote = ` ${sizingBasisText(buyKwhDebiased, calNote)}${projSocAtWindowStartPct != null',
    to: '  const sizingNote = ` ${sizingBasisText(buyKwh, calNote)}${projSocAtWindowStartPct != null /* MUTANT */',
    why: 'With a learned calibration the worst case named disagrees with the calibration note beside it.',
  },
  {
    // v1.187.22 — REPLACES the "up to" mutant (the phrase is retired).
    id: 'C-xviii. ★★★ with no expected figure the headline falls back to the worst case',
    file: NCA,
    find: "    + `${expected.buyKwh == null ? '' : `: ~${round1(expected.buyKwh)} kWh expected`}.`;",
    to: "    + `${expected.buyKwh == null ? `: ~${round1(buyKwhDebiased)} kWh` : `: ~${round1(expected.buyKwh)} kWh expected`}.`; /* MUTANT */",
    why: 'A plan with no P50 basis heads the rationale with the sizing basis as if it were the charge.',
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
    find: '    // v1.187.22 — forwarded verbatim; see the destructure note above. R2 — never on a backup leg.\n    forceChargeEligible: forceChargeEligible === undefined ? undefined : legForceChargeEligible(legRole, forceChargeEligible),\n',
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
    find: '    forceChargeEligible: forceChargeOn(legRole),\n',
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
    // v1.187.22 — re-pointed: the title is the level and the expected draw.
    id: 'C-xxx. ★★★ the push title says the worst case',
    file: NOTIFY,
    find: "      + (expected == null ? '' : ` (~${kwh(expected)})`),",
    to: "      + ` (~${kwh(plan.buyKwh)})`, /* MUTANT */",
    why: 'The phone shows "~64.2 kWh" in the title — the figure the 10-12 night was cancelled on.',
  },
  {
    id: 'C-xxxi. ★★ the push body drops the expected figure',
    file: NOTIFY,
    find: "      + (expected == null ? '. ' : `, ~${kwh(expected)} of grid energy expected. `)",
    to: "      + '. ' /* MUTANT */",
    why: 'The push says where the pool is charged to but not how much it is expected to buy.',
  },
  {
    id: 'C-xxxii. ★★★ the spoken line says the worst case',
    file: IDX,
    find: '        expectedKwh: statedBuyKwh(plan),',
    to: '        expectedKwh: plan.buyKwh, /* MUTANT */',
    why: 'The speakers say "about 64 kilowatt hours" for a ~34 kWh draw.',
  },
  {
    id: 'C-xxxiii. ★★ the card\'s headline number is the worst case',
    file: WEB,
    // v1.187.22 — re-pointed: the label says "toward" on a window-bound night.
    find: "  return { main: exp.toFixed(1), unit: 'kWh', label: `expected charge ${to} ~${levelText}%` };",
    to: "  return { main: (plan.buyKwh ?? 0).toFixed(1), unit: 'kWh', label: `expected charge ${to} ~${levelText}%` }; /* MUTANT */",
    why: 'The dashboard shows the worst case as the charge while the push says the expected figure.',
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
    find: '    if (jit.startMs != null) {\n      // R2 — the P50 PV that lands in the pack during the force-charge is not bought (0 with no PV).\n      const fcLiftKwh = Math.max(0, levelKwh - jit.packKwh);\n      liftKwh += fcLiftKwh - pvWalk(fcLiftKwh, jit.startMs).creditKwh;',
    to: '    { /* MUTANT */\n      const fcLiftKwh = Math.max(0, levelKwh - Math.max(o.startKwh, reserveKwh));\n      liftKwh += fcLiftKwh - pvWalk(fcLiftKwh, jit.startMs ?? o.window.fromMs).creditKwh;',
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
    find: '  return byHour.get(key) ?? (slotTs < fromMs ? byHour.get(key + 1) : undefined);',
    to: '  return byHour.get(key); /* MUTANT */',
    why: 'At 21:05 with the band starting at 22:00 the plan states no expected figure (or, as before the review, up to ~3 kWh too little).',
  },
  {
    id: 'C-lii. ★ any missing hour is stood in for by the next',
    file: NCA,
    find: '  return byHour.get(key) ?? (slotTs < fromMs ? byHour.get(key + 1) : undefined);',
    to: '  return byHour.get(key) ?? byHour.get(key + 1); /* MUTANT */',
    why: 'A gap inside the span is papered over with a neighbour\'s load instead of voiding a figure with no basis.',
  },
  {
    id: 'C-liii. ★ the window bound skips a missing hour',
    file: NCA,
    find: '    if (h == null) return null;\n    kwh += gridGainKw(p50ChargeRateKw(',
    to: '    if (h == null) continue; /* MUTANT */\n    kwh += gridGainKw(p50ChargeRateKw(',
    why: 'A window hour with no basis silently shrinks the bound, capping the expected buy with no disclosure.',
  },
  // ── the after-the-fact pushes ──
  {
    // v1.187.22 — re-pointed: the summary is built by buildNightChargeMorningSummary.
    id: 'C-liv. ★★★ the morning summary states the worst case',
    file: IDX,
    find: '      expectedKwh: armedExpectedBuyKwh(state.day),\n',
    to: '      expectedKwh: state.buyKwh, /* MUTANT */\n',
    why: 'The evening says ~35 kWh, the morning ~64 kWh — delivery reads as half the plan.',
  },
  {
    id: 'C-lv. ★★ the apply-failure push states the worst case',
    file: IDX,
    find: '    const expectedKwh = armedExpectedBuyKwh(state.day);',
    to: '    const expectedKwh = state.buyKwh; /* MUTANT */',
    why: 'The forfeited charge is stated as the worst case, called expected.',
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
    // v1.187.22 — REPLACES the unlabelled-worst-case mutant (armedBuyPhrase is retired).
    id: 'C-lv-d. ★★ with no expected figure an after-the-fact push still states a kWh figure',
    file: NCA,
    // v1.187.22 (recheck) — re-pointed: the phrase also states nothing for a no-charge night.
    find: '    ? `~${round1(expectedKwh)} kWh expected` : null;',
    to: "    ? `~${round1(expectedKwh)} kWh expected` : '~— kWh expected'; /* MUTANT */",
    why: 'An older plan row puts a placeholder figure in the morning push instead of none.',
  },
  // ── the no-basis headline ──
  {
    // v1.187.22 — re-pointed: the calibration rides in the sizing sentence.
    id: 'C-lvi. ★★ the sizing sentence drops the calibration',
    file: NCA,
    find: '  const sizingNote = ` ${sizingBasisText(buyKwhDebiased, calNote)}${projSocAtWindowStartPct != null',
    to: '  const sizingNote = ` ${sizingBasisText(buyKwhDebiased)}${projSocAtWindowStartPct != null /* MUTANT */',
    why: 'With a learned de-bias the worst case is named at ×1.66 with nothing saying so.',
  },
  // ── what is spoken and pushed: the charge the write arms ──
  {
    id: 'C-lvii. ★★★ the stated figure falls back to the worst case',
    file: NCA,
    find: '  return e != null && Number.isFinite(e) ? e : null;',
    to: '  return e != null && Number.isFinite(e) ? e : ((plan as any).buyKwh ?? null); /* MUTANT */',
    why: 'A plan with no P50 basis speaks and pushes ~64 kWh again — the pre-v1.187.22 fallback.',
  },
  {
    id: 'C-lviii. ★★★ the level ignores the force-charge stop',
    file: NCA,
    // v1.187.22 (recheck 3) — re-pointed: the level's return beside the no-start reserve.
    find: '  return plan.expectedForceChargeStartMs === null && reserve != null ? reserve : level;',
    to: '  return reserve; /* MUTANT */',
    why: 'A force-charge night (to 80%) is announced as a charge to the 50% reserve.',
  },
  {
    id: 'C-lix. ★★ the push states the sizing prediction as the level',
    file: NOTIFY,
    find: '  const level = chargeLevelPct(plan);',
    to: '  const level = plan.targetSocPct; /* MUTANT */',
    why: 'The title reads "~80.4%" (or a reserve-only night\'s unwritten 78%) instead of where the write stops.',
  },
  {
    id: 'C-lx. ★★ the island troughs lose their label',
    file: NOTIFY,
    // v1.187.22 (recheck) — re-pointed: the projection is shared by the charge and held shapes.
    find: '  const projection = `Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~${pct(plan.baselineMinSocPct)} `',
    to: '  const projection = `Tomorrow’s low SoC ~${pct(plan.baselineMinSocPct)} ` /* MUTANT */',
    why: '"Tomorrow’s low SoC ~0% with it" reads as the outcome; with the grid present the SHP2 holds the reserve.',
  },
  {
    id: 'C-lxi. ★★ an advisory push says the add-on is charging',
    file: NOTIFY,
    // v1.187.22 — re-pointed: "to" or "toward".
    find: '    title: `Night-charge: ${supervised ? `charging ${to} ${levelText}` : `charge ${to} ${levelText} recommended`} tonight`',
    to: '    title: `Night-charge: charging ${to} ${levelText} tonight` /* MUTANT */',
    why: 'In advisory mode nothing is written; the title would claim an action the add-on does not take.',
  },
  {
    id: 'C-lxii. ★★ the spoken line says "about 0 kilowatt hours"',
    file: ACT,
    find: "    : kwh < 1 ? ', less than 1 kilowatt hour'",
    to: "    : kwh < 0 ? ', less than 1 kilowatt hour' /* MUTANT */",
    why: 'A pool expected above the level is announced as a charge of "about 0".',
  },
  {
    id: 'C-lxiii. ★★ the English line drops the expected draw',
    file: ACT,
    // v1.187.22 — re-pointed: the line names the window, and "toward" a level it cannot reach.
    find: "      `Night charge notice. Charging the backup pool ${toward ? 'toward' : 'to about'} ${level} percent${kwhEn}, `",
    to: "      `Night charge notice. Charging the backup pool ${toward ? 'toward' : 'to about'} ${level} percent, ` /* MUTANT */",
    why: 'The speakers say where the pool is charged to but not how much it is expected to buy.',
  },
  {
    id: 'C-lxiv. ★★ the Spanish line drops the expected draw',
    file: ACT,
    find: "      + `${kwhEs}, en la ventana de carga que comienza ${o.deadlineTextEs}${toward ? ' y termina antes de alcanzar ese nivel' : ''}.`",
    to: "      + `, en la ventana de carga que comienza ${o.deadlineTextEs}${toward ? ' y termina antes de alcanzar ese nivel' : ''}.` /* MUTANT */",
    why: 'The bilingual pair disagrees: the Spanish pass omits the figure the English states.',
  },
  {
    id: 'C-lxv. ★★ the morning summary drops the expected figure',
    file: NOTIFY,
    // v1.187.22 — re-pointed: the reserve-only shape of the completed summary.
    find: '      : `reserve raised to ${raised}${note} and restored to ${o.restorePct}%. `;',
    to: '      : `reserve raised to ${raised} and restored to ${o.restorePct}%. `; /* MUTANT */',
    why: 'Delivery is scored the next evening against a figure the morning push never stated.',
  },
  {
    id: 'C-lxvi. ★★ the apply-failure push drops the expected figure',
    file: NOTIFY,
    // v1.187.22 (recheck) — re-pointed: the charge shape of what will not happen.
    find: "    : `charge${expected ? ` (${expected})` : ''}`;",
    to: "    : 'charge'; /* MUTANT */",
    why: 'The warning does not say how much of a charge was forfeited.',
  },
  {
    id: 'C-lxvii. ★ the force-charge tail names the target, not where it stops',
    file: NOTIFY,
    // v1.187.22 (recheck) — re-pointed: every shape of the clause reads the stop from one place.
    find: '    const stop = `~${pct(forceChargeStopPct(ceiling))}`;',
    to: '    const stop = `~${pct(ceiling)}`; /* MUTANT */',
    why: 'The title says ~80% and the tail ~80.4%: an 80.4 target syncs an 80 ceiling and stops at 80.',
  },
  {
    id: 'C-lxviii. ★★ the worst-case entity loses its name',
    file: MQTT,
    find: "name: 'Night-Charge Buy (Worst Case)',",
    to: "name: 'Night-Charge Buy', /* MUTANT */",
    why: 'Home Assistant shows the sizing basis as "Night-Charge Buy", the purchase it is not.',
  },
  {
    id: 'C-lxix. ★★ the rationale headline states the sizing prediction as the level',
    file: NCA,
    // v1.187.22 (recheck) — re-pointed: the charge shape of the headline (recheck 3: its level
    // is headlineLevelPct).
    find: "    : `Charge ${expected.deliverableBound ? 'toward' : 'to'} ~${headlineLevelPct}% in the ${windowText}`",
    to: "    : `Charge ${expected.deliverableBound ? 'toward' : 'to'} ~${targetSocPct}% in the ${windowText}` /* MUTANT */",
    why: 'The headline names the islanded projection (80.4%) instead of where the write stops (80%).',
  },
  {
    id: 'C-lxx. ★ a window-bound charge is headlined as reaching the level',
    file: NCA,
    find: "    : `Charge ${expected.deliverableBound ? 'toward' : 'to'} ~${headlineLevelPct}% in the ${windowText}`",
    to: "    : `Charge to ~${headlineLevelPct}% in the ${windowText}` /* MUTANT */",
    why: 'Friday\'s one-hour window is headlined "to 80%" though it passes a fraction of the draw.',
  },
  {
    id: 'C-lxxi. ★★ the walk reads the in-progress hour\'s EV directly again',
    file: NCA,
    find: '    const ev = bandHourAt(byHour, slot, walkFromMs)?.evP90W;',
    to: '    const ev = byHour.get(Math.floor(slot / HOUR_MS))?.evP90W; /* MUTANT */',
    why: 'On a band starting at the next hour the first part-hour carries its load but not its EV: the start ignores the displacement the live tick counts.',
  },
  // ── no line presents a sizing figure as the outcome ──
  {
    id: 'C-lxxii. ★★★ the push calls the worst-case arrival expected again',
    file: NOTIFY,
    find: '      + `${supervised.targetPct}% (bounded write; auto-restores after the charge window closes). `',
    to: '      + `${supervised.targetPct}% (bounded write; auto-restores after the charge window closes). The pack is only expected to reach ~${pct(plan.targetSocPct)} — the reserve is the ask, not a forecast. ` /* MUTANT */',
    why: 'A reserve-only night reads "charging to ~50% … ~5.1 kWh expected … only expected to reach ~27.5%": two outcomes, the one called expected the sizing basis.',
  },
  {
    id: 'C-lxxiii. ★★ the rationale repeats the worst-case arrival as "expected"',
    file: NCA,
    find: "    ? ` The reserve is set to ${writtenPct}%${truncated ? ` — ${askName} asks for ${setpointSocPct}%, but the panel only accepts a backup reserve up to ${RESERVE_WRITE_MAX_PCT}%` : ` (${askName})`}.`",
    to: "    ? ` The reserve is set to ${writtenPct}%${truncated ? ` — ${askName} asks for ${setpointSocPct}%, but the panel only accepts a backup reserve up to ${RESERVE_WRITE_MAX_PCT}%` : ` (${askName})`}, and the window is only expected to reach ~${targetSocPct}%.` /* MUTANT */",
    why: 'The worst case\'s arrival is stated twice, the second time as what the window is expected to reach, beside the Expected: sentence\'s 50%.',
  },
  {
    id: 'C-lxxiv. ★★ the plan never carries the window bound',
    file: NCA,
    find: '    expectedDeliverableBound: expected.deliverableBound === true,',
    to: '    expectedDeliverableBound: false, /* MUTANT */',
    why: 'Friday\'s one-hour window is pushed, spoken and shown as a charge "to ~80%" that ends near 62%.',
  },
  {
    id: 'C-lxxv. ★★ the push says "to" on a window-bound night',
    file: NOTIFY,
    find: "  const to = bound ? 'toward' : 'to';",
    to: "  const to = 'to'; /* MUTANT */",
    why: 'The phone title says "charging to ~80%" for a window the plan itself says closes first.',
  },
  {
    id: 'C-lxxvi. ★★ the speakers are never told the window bound',
    file: IDX,
    find: '        toward: chargeIsWindowBound(plan),',
    to: '        toward: false, /* MUTANT */',
    why: 'The spoken line says "to about 80 percent" on a Friday the push says "toward".',
  },
  {
    id: 'C-lxxvii. ★★ the Spanish line says "hasta cerca del" a level the window cannot reach',
    file: ACT,
    find: "      `Aviso de carga nocturna. Se cargarán las baterías de respaldo ${toward ? 'rumbo al' : 'hasta cerca del'} ${level} por ciento`",
    to: "      `Aviso de carga nocturna. Se cargarán las baterías de respaldo hasta cerca del ${level} por ciento` /* MUTANT */",
    why: 'The bilingual pair disagrees on a window-bound night: the English says toward, the Spanish to.',
  },
  {
    id: 'C-lxxviii. ★★ the English line drops "which ends before it gets there"',
    file: ACT,
    find: "      + `in the charge window that opens ${o.deadlineText}${toward ? ', which ends before it gets there' : ''}.`",
    to: '      + `in the charge window that opens ${o.deadlineText}.` /* MUTANT */',
    why: '"Toward 80 percent" alone does not tell the listener the window closes first.',
  },
  {
    id: 'C-lxxix. ★★★ the speakers say charging starts at the write moment again',
    file: ACT,
    find: "      + `in the charge window that opens ${o.deadlineText}${toward ? ', which ends before it gets there' : ''}.`",
    to: "      + `starting ${o.deadlineText}${toward ? ', which ends before it gets there' : ''}.` /* MUTANT */",
    why: 'From 74% at 21:30 the pool is not charged at 00:00 — the house draws it until ~03:14 — yet the line says charging starts then.',
  },
  {
    id: 'C-lxxx. ★★★ the hold push states the whole-house island trough as the night\'s low',
    file: NOTIFY,
    find: '    const trough = plan.cushionTroughSocPct ?? plan.minProjSocPct ?? plan.baselineMinSocPct;',
    to: '    const trough = plan.minProjSocPct ?? plan.baselineMinSocPct; /* MUTANT */',
    why: '"the pack would close the charge window at ~0%, at or above the 31.1% line" — the pre-fix self-contradiction.',
  },
  {
    id: 'C-lxxxi. ★★ the hold push loses its islanded label',
    file: NOTIFY,
    find: '        `No overnight charge needed — even if the grid were lost overnight, ${wholeHouse',
    to: '        `No overnight charge needed — ${wholeHouse /* MUTANT */',
    why: 'An islanded projection reads as the night\'s outcome; with the grid present the SHP2 holds the reserve.',
  },
  {
    id: 'C-lxxxii. ★★★ a starved hold is pushed as "No overnight charge needed"',
    file: NOTIFY,
    find: '    if (plan.cushionShortfall) {\n      return {\n        ...base,\n        title: \'Night-charge: no charge tonight (the window cannot cover the cushion)\',',
    to: '    if (plan.cushionShortfall && plan.requiredExtraKwh < 0) { /* MUTANT */\n      return {\n        ...base,\n        title: \'Night-charge: no charge tonight (the window cannot cover the cushion)\',',
    why: 'A window that cannot cover the cushion reads as a night with nothing to do, and the residual risk goes unsaid.',
  },
  {
    id: 'C-lxxxiii. ★★ a hold that needs a top-up says the cushion is covered',
    file: NOTIFY,
    find: '    if (plan.requiredExtraKwh > 0) {',
    to: '    if (plan.requiredExtraKwh > 1e9) { /* MUTANT */',
    why: 'A need under the minimum buy is pushed as "No overnight charge needed … at or above the line".',
  },
  {
    id: 'C-lxxxiv. ★★ the push\'s floor+cushion line is the legacy flat band',
    file: NOTIFY,
    // v1.187.22 (recheck) — re-pointed: one line for the hold and the charge shapes.
    find: "  // reserveFloorPct + cushionPct band the charge shape used to state beside the hold's line.\n  const line = floorCushionLinePct(plan);",
    to: "  // reserveFloorPct + cushionPct band the charge shape used to state beside the hold's line.\n  const line = plan.reserveFloorPct + plan.cushionPct; /* MUTANT */",
    why: 'The hold and the charge push state 31% beside a plan sized on its applied cushion line (31.1%; 27.6% on an 8 h resilience cushion).',
  },
  {
    id: 'C-lxxxv. ★★ the card\'s hold summary states the whole-house trough',
    file: WEB,
    find: '  const trough = plan.cushionTroughSocPct ?? plan.minProjSocPct ?? plan.baselineMinSocPct;\n  const line = floorCushionLinePct(plan);',
    to: '  const trough = plan.baselineMinSocPct; /* MUTANT */\n  const line = floorCushionLinePct(plan);',
    why: 'The card says "~0%" where the push says "~37.5%" for the same hold.',
  },
  {
    id: 'C-lxxxvi. ★★ the card\'s starved hold reads as fine',
    file: WEB,
    find: "      tone: 'warn',",
    to: "      tone: 'ok', /* MUTANT */",
    why: 'A window that cannot cover the cushion is shown in the all-clear colour.',
  },
  {
    id: 'C-lxxxvii. ★★★ a refused arm pushes the advisory recommendation',
    file: NOTIFY,
    find: '  if (!supervised && armRefused) {',
    to: "  if (!supervised && armRefused === '\\u0000') { /* MUTANT */",
    why: '"charge to ~80% … ~34.9 kWh of grid energy expected" for a force-charge night nothing will run.',
  },
  {
    id: 'C-lxxxviii. ★★ the evening job never passes the refusal',
    file: IDX,
    find: '    const msg = buildNightChargeMessage(plan, shape, supervisedCtx, armRefused, NIGHT_CHARGE_MODE);',
    to: '    const msg = buildNightChargeMessage(plan, shape, supervisedCtx); /* MUTANT */',
    why: 'The builder can say "NOT armed", but the push that goes out still recommends the write.',
  },
  {
    id: 'C-lxxxix. ★★ the refusal reason drifts from armFromPlan (the late-window check)',
    file: ACT,
    find: '  if (plan.window.startMs <= nowMs - APPLY_LATE_MS) return `the charge window opened more than ${APPLY_LATE_MS / 60_000} minutes ago`;',
    to: '  /* MUTANT */',
    why: 'A late refusal gets no reason, and the push falls back to the advisory recommendation.',
  },
  {
    id: 'C-xc. ★★ the morning push reports an owner cancel as completed',
    file: NOTIFY,
    find: "  if (o.ended === 'cancelled' || o.ended === 'gridLoss') {",
    to: "  if (o.ended === 'gridLoss' || (o.ended as string) === '\\u0000') { /* MUTANT */",
    why: '"completed … (~34.9 kWh expected)" for a charge the owner stopped.',
  },
  {
    id: 'C-xci. ★★ the revert never says why the night ended',
    file: IDX,
    find: "      ended: action.gridLossAbort ? 'gridLoss' : state.cancelled ? 'cancelled' : 'window',",
    to: "      ended: 'window', /* MUTANT */",
    why: 'A cancel or a grid-loss abort is pushed as a completed night with its full expected purchase.',
  },
  {
    id: 'C-xcii. ★★ the morning push pairs the force-charge figure with the reserve alone',
    file: NOTIFY,
    // v1.187.22 (recheck) — re-pointed: the shape of a force-charge that ran.
    find: '      ? `${reserve}, and force-charge ran${toward}${note}; ${restored}`',
    to: '      ? `${reserve}${note}; ${restored}` /* MUTANT */',
    why: '"reserve raised to 50% (~34.9 kWh expected)": the figure covers the force-charge to 80%, which the push never names.',
  },
  {
    id: 'C-xciii. ★★ the revert never passes what the force-charge did',
    file: IDX,
    // v1.187.22 (recheck) — re-pointed: the outcome from the actuation record.
    find: '      forceCharge: forceChargeNightOutcome(state, forceChargeOn()),',
    to: '      forceCharge: null, /* MUTANT */',
    why: 'The morning push names the 50% reserve beside a figure that covers the force-charge leg, and never says whether it ran.',
  },
  {
    id: 'C-xciv. ★ the force-charge stop ignores whether force-charge is enabled',
    file: FC,
    find: '  return enabled && c != null && Number.isFinite(c) && c > RESERVE_WRITE_MAX_PCT ? forceChargeStopPct(c) : null;',
    to: '  return c != null && Number.isFinite(c) && c > RESERVE_WRITE_MAX_PCT ? forceChargeStopPct(c) : null; /* MUTANT */',
    why: 'With force-charge disabled the morning push names a force-charge to 80% that never ran.',
  },
  {
    id: 'C-xcv. ★★ the arrival entity is named "Expected SoC" again',
    file: MQTT,
    find: "name: 'Night-Charge Arrival SoC (Worst Case)',",
    to: "name: 'Night-Charge Expected SoC', /* MUTANT */",
    why: 'Home Assistant shows the worst case\'s arrival as the expected SoC beside the expected buy.',
  },
  {
    id: 'C-xcvi. ★★ the card labels the worst-case arrival "Expected SoC" again',
    file: CARD,
    find: '          label="Worst-case arrival"',
    to: '          label="Expected SoC"',
    why: '"Expected SoC 80%" beside "expected charge to ~50%": two outcomes on one card.',
  },
  {
    id: 'C-xcvii. ★★ the card\'s headline ignores the window bound',
    file: WEB,
    find: "  const to = plan.expectedDeliverableBound === true ? 'toward' : 'to';",
    to: "  const to = 'to'; /* MUTANT */",
    why: 'The dashboard says "expected charge to ~80%" for Friday\'s window while the push says toward.',
  },

  // ── v1.187.22 (recheck) — a night expected to charge nothing ──
  {
    id: 'C-xcviii. ★★★ a no-charge night is never recognised',
    file: ACT,
    find: '  return kwh != null && Number.isFinite(kwh) && kwh < NO_CHARGE_EXPECTED_KWH;',
    to: '  return kwh != null && Number.isFinite(kwh) && kwh < 0; /* MUTANT */',
    why: '"charging to ~50% tonight (~0 kWh)" on the push, "less than 1 kilowatt hour" on the speakers, "0.0 kWh" on the card.',
  },
  {
    id: 'C-xcix. ★★ no expected figure counts as an expectation of none',
    file: ACT,
    find: '  return kwh != null && Number.isFinite(kwh) && kwh < NO_CHARGE_EXPECTED_KWH;',
    to: '  return kwh == null || (Number.isFinite(kwh) && kwh < NO_CHARGE_EXPECTED_KWH); /* MUTANT */',
    why: 'A plan with no P50 basis is announced as a reserve hold with no charge expected.',
  },
  {
    id: 'C-c. ★★ the held spoken line names the level, not the reserve',
    file: ACT,
    find: '    const reserve = Math.round(o.reservePct);',
    to: '    const reserve = Math.round(o.levelPct); /* MUTANT */',
    why: 'A force-charge night with no start expected is announced as "the backup reserve will be held at 80 percent".',
  },
  {
    id: 'C-ci. ★★★ the speakers announce a no-charge night as a charge',
    file: ACT,
    find: '  if (isNoChargeKwh(o.expectedKwh)) {',
    to: '  if (o.expectedKwh === -1) { /* MUTANT */',
    why: '"Charging the backup pool to about 50 percent, less than 1 kilowatt hour" for a night that charges nothing.',
  },
  {
    id: 'C-cii. ★★ the speakers are never told the reserve',
    file: IDX,
    find: '        reservePct: supervisedCtx.targetPct,',
    to: '        reservePct: chargeLevelPct(plan) ?? supervisedCtx.targetPct, /* MUTANT */',
    why: 'The held line speaks the force-charge stop as the reserve the panel holds.',
  },
  {
    id: 'C-ciii. ★★★ the push never recognises a no-charge night',
    file: NOTIFY,
    find: '  const held = noChargeExpected(plan);',
    to: '  const held = false; /* MUTANT */',
    why: 'The push title reads "charging to ~50% tonight (~0 kWh)" for a night the pool stays above the reserve.',
  },
  {
    id: 'C-civ. ★★ an advisory no-charge push claims the add-on holds the reserve',
    file: NOTIFY,
    find: '      title: `Night-charge: ${supervised ? `reserve held at ${reserveText}` : `reserve hold at ${reserveText} recommended`} tonight — no charge expected`,',
    to: '      title: `Night-charge: reserve held at ${reserveText} tonight — no charge expected`, /* MUTANT */',
    why: 'In advisory mode nothing is written; the title would claim an action the add-on does not take.',
  },
  {
    id: 'C-cv. ★★ the held push says the pool stays above a reserve it opens under',
    file: NOTIFY,
    find: '    const stays = start != null && Number.isFinite(start) && reservePct != null && start >= reservePct',
    to: '    const stays = start != null && Number.isFinite(start) && reservePct != null && start >= 0 /* MUTANT */',
    why: '"the pool should open the window near ~49.98% and stay at or above 50%" — a clause its own figure contradicts.',
  },
  {
    id: 'C-cvi. ★★ the held push calls the write "this charge"',
    file: NOTIFY,
    find: "    + `without ${held ? \"tonight's write\" : 'this charge'}, ~${pct(plan.minProjSocPct)} with it; the floor+cushion line is ${pct(line)}. `",
    to: "    + `without this charge, ~${pct(plan.minProjSocPct)} with it; the floor+cushion line is ${pct(line)}. ` /* MUTANT */",
    why: 'A night that charges nothing is described as having a charge.',
  },
  {
    id: 'C-cvii. ★ the held push calls the write an economic buy',
    file: NOTIFY,
    find: "    ? ` Resilience needs no buy tonight — the pack already covers the outage cushion; this ${held ? 'write' : 'buy'} is economic (cost mode).`",
    to: "    ? ' Resilience needs no buy tonight — the pack already covers the outage cushion; this buy is economic (cost mode).' /* MUTANT */",
    why: '"this buy is economic" on a night no buy is expected.',
  },
  {
    id: 'C-cviii. ★★ the rationale headlines a no-charge night as a charge of ~0 kWh',
    file: NCA,
    find: '  const chargeHeadline = isNoChargeKwh(expected.buyKwh)',
    to: '  const chargeHeadline = (expected.buyKwh as number | null) === -1 /* MUTANT */',
    why: '"Charge to ~50% in the 00:00–05:00 window: ~0 kWh expected."',
  },
  {
    id: 'C-cix. ★★ the after-the-fact phrase states "~0 kWh expected"',
    file: NCA,
    find: '  return expectedKwh != null && Number.isFinite(expectedKwh) && !isNoChargeKwh(expectedKwh)',
    to: '  return expectedKwh != null && Number.isFinite(expectedKwh) /* MUTANT */',
    why: 'The morning push of a reserve-held night reads "(~0 kWh expected)".',
  },
  {
    id: 'C-cx. ★★ the morning push reports a reserve hold as a raise with no figure',
    file: NOTIFY,
    find: '  const held = isNoChargeKwh(o.expectedKwh);',
    to: '  const held = false; /* MUTANT */',
    why: 'A night that only held the reserve is reported as "reserve raised to 50%", silent on why nothing was charged.',
  },
  {
    id: 'C-cxi. ★ the apply-failure push calls a reserve hold a planned charge',
    file: NOTIFY,
    find: '  const planned = isNoChargeKwh(o.expectedKwh)',
    to: '  const planned = (o.expectedKwh as number | null) === -1 /* MUTANT */',
    why: '"Tonight\'s planned charge will not happen" for a night that was expected to charge nothing.',
  },
  {
    id: 'C-cxii. ★★ the card shows "0.0 kWh expected charge" on a no-charge night',
    file: WEB,
    // v1.187.22 (recheck 3) — re-pointed: the card's no-charge test is noChargeExpected.
    find: '  if (noChargeExpected(plan)) {',
    to: '  if (false as boolean) { /* MUTANT */',
    why: 'The dashboard leads with "0.0 kWh — expected charge to ~50%" while the push says the reserve is held.',
  },
  {
    id: 'C-cxiii. ★★ the card\'s held lead names the level, not the reserve',
    file: WEB,
    // v1.187.22 (recheck 3) — re-pointed: the held lead reads writtenReservePct.
    find: "    return { main: written == null ? '—' : `${written}`, unit: '%', label: 'reserve held as a floor — no charge expected' };",
    to: "    return { main: levelText, unit: '%', label: 'reserve held as a floor — no charge expected' }; /* MUTANT */",
    why: 'A force-charge night with no start expected shows "80% reserve held as a floor".',
  },
  {
    id: 'C-cxiv. ★ the card\'s no-charge threshold drifts from the server\'s',
    file: WEB,
    find: ' *  nightChargeActuator.ts): what the card would show as "0.0 kWh". */\nexport const NO_CHARGE_EXPECTED_KWH = 0.05;',
    to: ' *  nightChargeActuator.ts): what the card would show as "0.0 kWh". */\nexport const NO_CHARGE_EXPECTED_KWH = 0.5; /* MUTANT */',
    why: 'A 0.3 kWh night is a charge on the push and a reserve hold on the card.',
  },
  // ── what the force-charge did, from the actuation record ──
  {
    id: 'C-cxv. ★★★ every force-charge switched ON is reported as having run',
    file: FC,
    // v1.187.22 (recheck 3) — re-pointed: the failed shape returns on its own line.
    find: "    return { kind: on === 'verified' ? 'ran' : 'unconfirmed', stopPct, expectedLeg };",
    to: "    return { kind: 'ran', stopPct, expectedLeg }; /* MUTANT */",
    why: 'A force-charge whose ON never took effect is pushed as "force-charge ran toward ~80% (~34.9 kWh expected)".',
  },
  {
    id: 'C-cxvi. ★★ an unverified ON is reported as never started',
    file: FC,
    find: '  if (on != null) {',
    // (recheck 3 — the failed shape is narrowed inside: the cast keeps the mutant compiling.)
    to: "  if (on === 'verified' || (on as string) === '\\u0000') { /* MUTANT */",
    why: 'A force-charge switched ON (and failed, or never confirmed) is reported as never having started.',
  },
  {
    id: 'C-cxvii. ★★★ the morning push reports a force-charge that never started as having run',
    file: NOTIFY,
    find: "    night = fc.kind === 'ran'",
    to: "    night = (fc.kind as string) !== 'failed' && (fc.kind as string) !== 'unconfirmed' /* MUTANT */",
    why: 'The 10-12 morning push names "force-charge ran toward ~80%" on a night decideForceCharge never started it.',
  },
  {
    id: 'C-cxviii. ★★ the expected figure rides a force-charge that did not run',
    file: NOTIFY,
    // v1.187.22 (recheck 3) — re-pointed: the figure is decided once (figureFits) for every account.
    find: "  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;",
    to: "  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.expectedLeg === true; /* MUTANT */",
    why: '"reserve raised to 50% (~34.9 kWh expected); force-charge toward ~80% never started": a figure for a leg that never ran.',
  },
  {
    id: 'C-cxix. ★ a failed ON is reported as merely unconfirmed',
    file: NOTIFY,
    // v1.187.22 (recheck 3) — re-pointed: the failed wording is failedOn (whole or partial).
    find: "        : fc.kind === 'failed' ? failedOn",
    to: "        : fc.kind === 'unconfirmed' ? failedOn /* MUTANT */",
    why: 'The warning already said the ON did not take effect; the morning push softens it to "never confirmed".',
  },
  // ── when the force-charge is expected to start ──
  {
    id: 'C-cxx. ★★ the plan never carries the expected force-charge start',
    file: NCA,
    find: '    ...(expected.forceChargeStartMs !== undefined ? { expectedForceChargeStartMs: expected.forceChargeStartMs } : {}),',
    to: '    /* MUTANT */',
    why: 'The push falls back to an untimed clause on every night, Friday included.',
  },
  {
    id: 'C-cxxi. ★★★ a window-bound night is told the force-charge reaches the stop',
    file: NOTIFY,
    find: "    return bound\n      ? `Then it switches the panel's force-charge ON at ~${at}",
    to: "    return false /* MUTANT */\n      ? `Then it switches the panel's force-charge ON at ~${at}",
    why: 'Friday: "charging toward ~80%" then "just long enough to reach ~80%" for a window that closes near 62%.',
  },
  {
    id: 'C-cxxii. ★★ the force-charge clause names the window close as its start',
    file: NOTIFY,
    find: '    const at = fmtPhoenixDayHm(startMs, plan.generatedAt);',
    to: '    const at = fmtPhoenixDayHm(plan.window!.endMs, plan.generatedAt); /* MUTANT */',
    why: 'The push says the force-charge switches on at 05:00 on a night it is due at ~02:43.',
  },
  {
    id: 'C-cxxiii. ★★ a force-charge not expected to start is pushed as switching on',
    file: NOTIFY,
    find: "    if (held || startMs === null) {\n      return `It also arms the panel's force-charge toward ${stop}, timed to finish by the window close; it is not expected to start. `;\n    }\n    if (startMs === undefined) {",
    to: "    if (held) { /* MUTANT */\n      return `It also arms the panel's force-charge toward ${stop}, timed to finish by the window close; it is not expected to start. `;\n    }\n    if (startMs == null) {",
    why: 'A night whose walk expects no start is told the force-charge switches on just in time.',
  },
  {
    id: 'C-cxxiv. ★★ a no-charge night is pushed a timed force-charge',
    file: NOTIFY,
    find: '    if (held || startMs === null) {',
    to: '    if (startMs === null) { /* MUTANT */',
    why: '"reserve held — no charge expected" above "it switches the panel\'s force-charge ON at ~04:30".',
  },
  // ── one floor+cushion line ──
  {
    id: 'C-cxxv. ★★ the server\'s line ignores the applied cushion',
    file: NCA,
    find: "'cushionPct'>,\n): number | null {\n  const line = plan.cushionLineSocPct;\n  if (line != null && Number.isFinite(line)) return line;",
    to: "'cushionPct'>,\n): number | null {\n  const line = plan.cushionLineSocPct;\n  if (line != null && Number.isFinite(line) && line < 0) return line; /* MUTANT */",
    why: 'Every push states reserve floor + the flat band (31%) beside a plan sized on 27.55%.',
  },
  {
    id: 'C-cxxvi. ★★ the card\'s line ignores the applied cushion',
    file: WEB,
    find: '(plan: FloorCushionPlan): number | null {\n  const line = plan.cushionLineSocPct;\n  if (line != null && Number.isFinite(line)) return line;',
    to: '(plan: FloorCushionPlan): number | null {\n  const line = plan.cushionLineSocPct;\n  if (line != null && Number.isFinite(line) && line < 0) return line; /* MUTANT */',
    why: 'The card states 31% where the push states 27.6% for the same plan.',
  },
  {
    id: 'C-cxxvii. ★★ the card\'s stat states the legacy flat band',
    file: CARD,
    find: '  const floorCushionLine = fmtLinePct(floorCushionLinePct(plan));',
    to: '  const floorCushionLine = `${(plan.reserveFloorPct + plan.cushionPct).toFixed(0)}%`; /* MUTANT */',
    why: '"Island low, with charge … floor+cushion 31%" beside a push and a hold summary at 31.1%.',
  },
  {
    id: 'C-cxxviii. ★★ the card\'s hold summary states the legacy flat band',
    file: WEB,
    find: '  const line = floorCushionLinePct(plan);\n  const wholeHouse',
    to: '  const line = plan.reserveFloorPct + plan.cushionPct; /* MUTANT */\n  const wholeHouse',
    why: 'The card\'s hold says 31% where the hold push says 27.6%.',
  },
  // ── the card leads with a refused arm ──
  {
    id: 'C-cxxix. ★★ a refusal is served beside another window\'s plan',
    file: ACT,
    find: '  if (plan.window.startMs !== rec.windowStartMs || plan.window.endMs !== rec.windowEndMs) return null;',
    to: '  /* MUTANT */',
    why: 'Saturday\'s refusal stays on the card for a different window\'s armed plan.',
  },
  {
    id: 'C-cxxx. ★★ a refusal outlives its window',
    file: ACT,
    find: '  return nowMs < rec.windowEndMs ? rec.reason : null;',
    to: '  return rec.reason; /* MUTANT */',
    why: 'The card says "not armed tonight" the next day about a window that has closed.',
  },
  {
    id: 'C-cxxxi. ★ an advisory card leads with a write-mode refusal',
    file: ACT,
    find: "  if (rec == null || mode === 'advisory' || plan == null || !plan.chargeTonight || plan.window == null) return null;",
    to: '  if (rec == null || plan == null || !plan.chargeTonight || plan.window == null) return null; /* MUTANT */',
    why: 'Advisory arms nothing; a refusal recorded before a mode change leads the advisory card.',
  },
  {
    id: 'C-cxxxii. ★ an empty reason is read back as a refusal',
    file: ACT,
    find: "  if (typeof o.reason !== 'string' || o.reason.length === 0 || !fin(o.windowStartMs) || !fin(o.windowEndMs)) return null;",
    to: "  if (typeof o.reason !== 'string' || !fin(o.windowStartMs) || !fin(o.windowEndMs)) return null; /* MUTANT */",
    why: 'A malformed latch file fabricates "not armed tonight — ." on the card.',
  },
  {
    id: 'C-cxxxiii. ★★ the evening job never records the refusal',
    file: IDX,
    // v1.187.22 (recheck 3) — re-pointed: the record is eveningNotArmedReason's.
    find: '      armRefused: notArmed && plan?.window\n',
    to: "      armRefused: notArmed === '\\u0000' && plan?.window /* MUTANT */\n",
    why: 'The push says "NOT armed" and the card still leads with "34.9 kWh — expected charge to ~80%".',
  },
  {
    id: 'C-cxxxiv. ★★ the status route never serves the refusal',
    file: IDX,
    find: '    armRefusal: servedArmRefusal(latch.armRefused, plan, NIGHT_CHARGE_MODE, Date.now()),',
    to: '    armRefusal: null, /* MUTANT */',
    why: 'The refusal is recorded and never reaches the card.',
  },
  {
    id: 'C-cxxxv. ★★ the latch drops the refusal in memory',
    file: IDX,
    find: '  nightChargeLatchMem = { lastNotifyDay: l.lastNotifyDay, armRefused: l.armRefused ?? null };',
    to: '  nightChargeLatchMem = { lastNotifyDay: l.lastNotifyDay }; /* MUTANT */',
    why: 'The refusal reaches the file but not the route, until a restart.',
  },
  {
    id: 'C-cxxxvi. ★ a restart forgets the refusal',
    file: IDX,
    find: "    return { lastNotifyDay: typeof d === 'string' ? d : null, armRefused: coerceArmRefusalRecord(raw?.armRefused) };",
    to: "    return { lastNotifyDay: typeof d === 'string' ? d : null, armRefused: null }; /* MUTANT */",
    why: 'After an add-on update mid-evening the card leads with the expected charge again.',
  },
  {
    id: 'C-cxxxvii. ★★ the card never leads with the refusal',
    file: CARD,
    // v1.187.22 (recheck 3) — re-pointed: the lead is built over two lines.
    find: "  const refused = status.mode !== 'advisory' && status.armRefusal\n",
    to: "  const refused = (status.mode as string) === '\\u0000' && status.armRefusal /* MUTANT */\n",
    why: 'The dashboard says "34.9 kWh — expected charge to ~80%" on a night nothing is armed.',
  },
  {
    id: 'C-cxxxviii. ★ the card\'s refused lead drops the reason',
    file: WEB,
    find: '    headline: `Planned charge not armed tonight — ${reason}.`,',
    to: "    headline: 'Planned charge not armed tonight.', /* MUTANT */",
    why: 'The card says nothing is armed but not why; the push names the unresolved prior night.',
  },  // ── v1.187.22 (recheck 3): the level a force-charge night with no start expected reaches ──
  {
    id: 'C-cxxxix. ★★★ a force-charge night with no start expected is stated at the stop',
    file: NCA,
    find: '  return plan.expectedForceChargeStartMs === null && reserve != null ? reserve : level;',
    to: '  return level; /* MUTANT */',
    why: 'From 40% under a 51% ceiling the push, the speakers and the card say "to ~51%" for ~18 kWh that stops at the 50% reserve.',
  },
  {
    id: 'C-cxl. ★★ the rationale headline states the stop on a night with no start expected',
    file: NCA,
    find: '    setpointSocPct, expectedWriteLevelPct: expected.levelPct, expectedForceChargeStartMs: expected.forceChargeStartMs,\n  }) ?? writtenPct;',
    to: '    setpointSocPct, expectedWriteLevelPct: expected.levelPct,\n  }) ?? writtenPct; /* MUTANT */',
    why: 'The rationale headline says "Charge to ~51%" above "the just-in-time force-charge to 51% is not expected to start".',
  },
  {
    id: 'C-cxli. ★★ the card states the stop on a night with no start expected',
    file: WEB,
    find: '    ? (plan.expectedForceChargeStartMs === null && written != null ? written : lvl)',
    to: '    ? lvl /* MUTANT */',
    why: 'The card says "18.0 kWh — expected charge to ~51%" where the push says ~50%.',
  },
  // ── whether force-charge rode the night: stamped at arm time ──
  {
    id: 'C-cxlii. ★★★ the morning push reads the option at the restore, not the stamp',
    file: FC,
    find: '  const armedStop = armedForceChargeStopPct(s, s.forceChargeRides ?? enabled);',
    to: '  const armedStop = armedForceChargeStopPct(s, enabled); /* MUTANT */',
    why: 'A restart with force-charge switched off turns an armed-to-ride night into "reserve raised to 50% (~34.9 kWh expected)".',
  },
  {
    id: 'C-cxliii. ★★★ the arm never stamps whether force-charge rides the night',
    file: ACT,
    find: '      : forceChargeEnabled && ceiling != null && ceiling > RESERVE_WRITE_MAX_PCT,',
    to: '      : null, /* MUTANT */',
    why: 'Every record reads as armed before the stamp: the option at the restore decides again.',
  },
  {
    id: 'C-cxliv. ★★ the stamp ignores the armed ceiling',
    file: ACT,
    find: '      : forceChargeEnabled && ceiling != null && ceiling > RESERVE_WRITE_MAX_PCT,',
    to: '      : forceChargeEnabled, /* MUTANT */',
    why: 'A 50% ceiling (the reserve reaches it alone) is stamped as riding: the morning says "force-charge … never started".',
  },
  {
    id: 'C-cxlv. ★★ a restart forgets the stamp',
    file: ACT,
    find: "    forceChargeRides: typeof o.forceChargeRides === 'boolean' ? o.forceChargeRides : null,",
    to: '    forceChargeRides: null, /* MUTANT */',
    why: 'An add-on update mid-night loses the stamp, and the option at the restore decides again.',
  },
  {
    id: 'C-cxlvi. ★★ a record from before the stamp is read as reserve only for certain',
    file: FC,
    find: '  const expectedLeg = s.forceChargeRides ?? (above ? null : false);',
    to: '  const expectedLeg = s.forceChargeRides ?? false; /* MUTANT */',
    why: 'The figure that may count the force-charge leg is named beside a reserve-only account.',
  },
  {
    id: 'C-cxlvii. ★★★ the morning names the figure beside any reserve-only or ran account',
    file: NOTIFY,
    find: "  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;",
    to: "  const figureFits = fc.kind === 'none' || fc.kind === 'ran'; /* MUTANT */",
    why: '"reserve raised to 50% (~34.9 kWh expected)": the force-charge leg\'s figure beside a reserve-only account.',
  },
  {
    id: 'C-cxlviii. ★★ index.ts arms without the force-charge gate',
    file: IDX,
    // v1.189.0 — re-pointed: the arm goes through armCycle (chargeCycle.ts), the gate on its leg.
    find: "        role: 'cost', kind: 'overnight', plan, forceChargeEnabled: forceChargeOn(), nextOnPeakStartMs: armOnPeakStartMs,",
    to: "        role: 'cost', kind: 'overnight', plan, forceChargeEnabled: undefined, nextOnPeakStartMs: armOnPeakStartMs, /* MUTANT */",
    why: 'Every armed record carries no stamp, so the morning reads the option at the restore.',
  },
  {
    id: 'C-cxlix. ★ the evening push names the force-charge from the option, not the stamp',
    file: IDX,
    find: '          forceChargeTargetPct: armedCandidate.forceChargeRides === true ? armedCandidate.forceChargeCeilingPct : null,',
    to: '          forceChargeTargetPct: forceChargeOn() ? armedCandidate.forceChargeCeilingPct : null, /* MUTANT */',
    why: 'A 50% ceiling is pushed as "It also arms the panel\'s force-charge toward ~50%".',
  },
  // ── a force-charge ON that failed on only some slots ──
  {
    id: 'C-cl. ★★ a partial ON failure is read as a whole-night failure',
    file: FC,
    find: '  return failed.length < ours.length ? [...failed] : null;',
    to: '  return null; /* MUTANT */',
    why: 'The morning push says force-charge "did not take effect" though slots 1 and 3 took it.',
  },
  {
    id: 'C-cli. ★★ the outcome drops the partial slots',
    file: FC,
    find: "    if (on === 'failed') return { kind: 'failed', stopPct, expectedLeg, partialSlots: partialForceChargeOnFailureSlots(s) };",
    to: "    if (on === 'failed') return { kind: 'failed', stopPct, expectedLeg, partialSlots: null }; /* MUTANT */",
    why: 'The record knows only slot 2 failed; the morning push still reports a whole-night failure.',
  },
  {
    id: 'C-clii. ★★ the morning push ignores a partial failure',
    file: NOTIFY,
    find: "    const failedOn = fc.kind === 'failed' && fc.partialSlots != null\n",
    to: "    const failedOn = fc.kind === 'failed' && fc.partialSlots != null && fc.partialSlots.length > 99 /* MUTANT */\n",
    why: 'The warning said "on those slot(s)"; the morning push says the force-charge did not take effect.',
  },
  {
    id: 'C-cliii. ★ a restart forgets which slots failed',
    file: ACT,
    find: '    forceChargeOnFailedSlots: Array.isArray(o.forceChargeOnFailedSlots)\n',
    to: '    forceChargeOnFailedSlots: Array.isArray(o.forceChargeOnFailedSlots) && Number.isNaN(1) /* MUTANT */\n',
    why: 'An add-on update before the restore turns a partial failure into a whole-night one.',
  },
  {
    id: 'C-cliv. ★★ index.ts never records which slots failed',
    file: IDX,
    find: '    persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] });',
    to: '    persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs }); /* MUTANT */',
    why: 'Every failure reads as whole-night in the morning, partial ones included.',
  },
  // ── every way a night ends up not armed ──
  {
    id: 'C-clv. ★★ an arm no announcement delivered records nothing',
    file: ACT,
    find: '  return priorWrites ? null : ARM_UNDELIVERED_REASON;',
    to: '  return null; /* MUTANT */',
    why: 'Nothing is armed, and the card still leads with "34.9 kWh — expected charge to ~80%".',
  },
  {
    id: 'C-clvi. ★★ an undelivered arm is recorded over a prior arm that will still write',
    file: ACT,
    find: '  return priorWrites ? null : ARM_UNDELIVERED_REASON;',
    to: '  return ARM_UNDELIVERED_REASON; /* MUTANT */',
    why: 'Saturday\'s arm for the shared Monday window writes, and the card says "not armed tonight".',
  },
  {
    id: 'C-clvii. ★ a cancelled prior arm counts as one that will still write',
    file: ACT,
    find: '  const priorWrites = p.day != null && !p.cancelled && p.targetPct != null && p.revertedAtMs == null\n',
    to: '  const priorWrites = p.day != null && p.targetPct != null && p.revertedAtMs == null /* MUTANT */\n',
    why: 'Nothing will write, and the card leads with the expected charge.',
  },
  {
    id: 'C-clviii. ★★ index.ts records only refusals',
    file: IDX,
    find: '      refused: armRefused, candidate: armedCandidate, delivered: haNotifyDelivered || audibleDelivered, prior: nightActuationMem,',
    to: '      refused: armRefused, candidate: null, delivered: haNotifyDelivered || audibleDelivered, prior: nightActuationMem, /* MUTANT */',
    why: 'An arm no channel delivered is not recorded; the card leads with a charge nothing will make.',
  },
  {
    id: 'C-clix. ★★ the missed evening drops a refusal that still stands',
    file: IDX,
    find: '    writeNightChargeLatch({ lastNotifyDay: today, armRefused: latch.armRefused ?? null });',
    to: '    writeNightChargeLatch({ lastNotifyDay: today }); /* MUTANT */',
    why: 'Saturday refused the Monday window; Sunday\'s evening is missed and the card leads with the expected charge.',
  },
  {
    id: 'C-clx. ★★ a refused hold is pushed as a planned charge',
    file: NOTIFY,
    find: "    return held\n      ? {\n        ...base,\n        title: 'Night-charge: planned reserve hold NOT armed tonight',",
    to: "    return false /* MUTANT */\n      ? {\n        ...base,\n        title: 'Night-charge: planned reserve hold NOT armed tonight',",
    why: '"Tonight\'s plan calls for a charge" on a night expected to charge nothing.',
  },
  {
    id: 'C-clxi. ★ auto mode is told "the supervised write"',
    file: NOTIFY,
    find: "    const write = mode === 'auto' ? 'the write' : 'the supervised write';",
    to: "    const write = 'the supervised write'; /* MUTANT */",
    why: 'Auto mode supervises nothing; the push names a supervised write.',
  },
  {
    id: 'C-clxii. ★★ the card leads a refused hold as a planned charge',
    file: WEB,
    find: '  if (o.held) {\n',
    to: '  if (false as boolean) { /* MUTANT */\n',
    why: '"Planned charge not armed tonight" on a night expected to charge nothing.',
  },
  {
    id: 'C-clxiii. ★ the card tells auto mode "the supervised write"',
    file: WEB,
    find: "  const write = o.mode === 'auto' ? 'the write' : 'the supervised write';",
    to: "  const write = 'the supervised write'; /* MUTANT */",
    why: 'The card and the push name the write differently in auto mode.',
  },
  {
    id: 'C-clxiv. ★★ the card never tells the lead which night it is',
    file: CARD,
    find: '    ? refusedArmLead(status.armRefusal, { mode: status.mode, held: noChargeNight, reservePct: writtenReservePct(plan, status.reserveWriteMaxPct ?? null) })',
    to: '    ? refusedArmLead(status.armRefusal) /* MUTANT */',
    why: 'The card says "calls for a charge … the supervised write" on an auto-mode reserve hold.',
  },
  // ── no EV-contention note on a night expected to charge nothing ──
  {
    id: 'C-clxv. ★★ the push keeps the EV note on a night expected to charge nothing',
    file: NOTIFY,
    find: "    + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote}${economicNote}${held ? '' : evNote} `;",
    to: '    + `Confidence: ${plan.confidenceTier}.${shortfallNote}${overBuyNote}${economicNote}${evNote} `; /* MUTANT */',
    why: '"no charge is expected" beside "leaving ~2.5 kW for the packs while the car charges".',
  },
  {
    id: 'C-clxvi. ★ the card keeps the EV line on a night expected to charge nothing',
    file: CARD,
    find: "      {!noChargeNight && plan.bindingCap === 'evContention'",
    to: "      {/* MUTANT */ plan.bindingCap === 'evContention'",
    why: 'The card leads with "reserve held as a floor — no charge expected" above "leaving ~2.5 kW for the packs".',
  },
  // ── the force-charge ON-failure push names the stop ──
  {
    id: 'C-clxvii. ★★ the ON-failure push names the raw ceiling again',
    file: NOTIFY,
    find: "  const toward = o.ceilingPct != null && Number.isFinite(o.ceilingPct) ? ` (toward ~${round1(forceChargeStopPct(o.ceilingPct))}%)` : '';",
    to: "  const toward = o.ceilingPct != null && Number.isFinite(o.ceilingPct) ? ` (toward ${o.ceilingPct}%)` : ''; /* MUTANT */",
    why: '"(toward 80.4%)" where every other surface says the force-charge stops at ~80%.',
  },
  {
    id: 'C-clxviii. ★★ the ON-failure push loses "on those slot(s)"',
    file: NOTIFY,
    find: '  const partial = partialForceChargeOnFailureSlots({ forceChargeSlots: o.ourSlots, forceChargeOnFailedSlots: o.slots }) != null;',
    to: '  const partial = false; /* MUTANT */',
    why: 'A failure on slot 2 alone is pushed as the whole buy above the reserve not happening.',
  },
  {
    id: 'C-clxix. ★ index.ts builds the ON-failure push without the armed ceiling',
    file: IDX,
    find: '        noRetry: action.noRetry === true, ceilingPct: state.forceChargeCeilingPct,',
    to: '        noRetry: action.noRetry === true, ceilingPct: null, /* MUTANT */',
    why: 'The warning no longer says where the forfeited force-charge would have stopped.',
  },
  // ── (final review) a spoken detail states its figures whole ──
  {
    id: 'C-clxx. ★★★ a decimal point is a sentence end again (the spoken cut lands in a figure)',
    file: TTS,
    find: '  for (const m of detail.matchAll(/[.!?]["\')\\]]*(?=\\s|$)/g)) {',
    to: '  for (const m of detail.matchAll(/[.!?]["\')\\]]*/g)) { /* MUTANT */',
    why: 'Every spoken peak-grid-draw with confirmed rates says "about $2." for $2.19, and host pressure "load1 6." for 6.37.',
  },
  {
    id: 'C-clxxi. ★★★ with no sentence end in range the cut is at char 200 again (a figure split mid-number)',
    file: TTS,
    find: '  const words = ws > 0 ? head.slice(0, ws) : detail.slice(0, SPOKEN_DETAIL_MAX_CHARS);',
    to: '  const words = detail.slice(0, SPOKEN_DETAIL_MAX_CHARS); /* MUTANT */',
    why: 'A reading of 12.05 straddling the limit is spoken "12.0".',
  },
  {
    id: 'C-clxxii. ★ a sentence end in the first 100 chars is taken (the spoken detail stops after one short clause)',
    file: TTS,
    find: '    if (at > SPOKEN_DETAIL_MIN_SENTENCE_CUT) sentenceEnd = end;',
    to: '    sentenceEnd = end; /* MUTANT */',
    why: 'A detail whose only early full stop is at char 60 speaks 60 chars and drops the reading that follows.',
  },
  {
    id: 'C-clxxiii. ★★ a sentence end past the limit is taken (the spoken detail runs long)',
    file: TTS,
    find: '    if (end > SPOKEN_DETAIL_MAX_CHARS) break;',
    to: '    /* MUTANT */',
    why: 'The cut lands at the last sentence end of the whole detail: the speakers read the full narration.',
  },
  {
    id: 'C-clxxiv. ★★★ peak-grid-draw calls the on-peak spend a premium over overnight again',
    file: PGD,
    find: '    : ` At the current ${v.periodLabel} rate that is about $${(v.centsPerHour / 100).toFixed(2)} per hour.`;',
    to: '    : ` At the current ${v.periodLabel} rate that is about $${(v.centsPerHour / 100).toFixed(2)} per hour more than buying the same energy overnight.`; /* MUTANT */',
    why: 'The push states $2.19/h as the extra over overnight; the real premium at 34 c against 8 c is $1.68/h.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22c', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
