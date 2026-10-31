#!/usr/bin/env node
/**
 * mutate-v1196-night.mjs — committed harness for v1.196.0, the night charge.
 *
 * (S) ONE TEST: the overnight write setpoint is the leg's own arm test. On the islanded-outage /
 * disabled basis the arm test is the pack at the window close against reserve + cushion; the
 * setpoint was solved on the whole-house walk to the next recharge, so every charge night asked
 * ~73-100% and wrote the 50% maximum. It is now the line, asked to the whole percent above it, or
 * the cost target where higher; the walk stays the legacy-pct band's, the backup leg's and T_mid's
 * R. The reserve sentence says "only accepts up to 50%" only when the envelope truncated the ask.
 * Mutants S-i..ix.
 *
 * (F) The force-charge ON-failure warning and its log line name each failed slot's Core, say when
 * the cloud does not have it, and name its work mode or its own backup reserve where those differ
 * from the other Cores' (forceChargeSlotCores, forceChargeFailedSlotsText). Mutants F-i..x.
 *
 * (N) The "no plan tonight" push names what refused the plan: every refused null plan carries
 * basisBlockedBy (declared since v1.148.0, never set), and a null plan says the panel's pool
 * readings are unavailable; the mid-day "no plan" push (the shadow's preview, the route the mid-day
 * switch takes) states the gate the same way. Mutants N-i..xii.
 *
 * (P) The cost ceiling's morning surplus de-biases the P50 PV as well as the load
 * (costSurplusPvFactor: expand-only, ≤ ×1.3, the 5 → 10 night ramp, never past an hour's P90),
 * on forecast-tier rows whose PV verdict stands and whose pool did not reach the charge taper
 * (pv_saturated, captured with actual_max_soc_pct). Mutants P-i..xx.
 *
 *   node scripts/mutate-v1196-night.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=1 beside other lanes.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const NFC = resolve(REPO, 'server/src/nightForceCharge.ts');
const NOTIFY = resolve(REPO, 'server/src/notify.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const CTEXT = resolve(REPO, 'server/src/chargeText.ts');
const SHADOW = resolve(REPO, 'server/src/middayShadow.ts');

const T_SET = 'test/setpointOneTest.test.ts';
const T_MID = 'test/middayPlan.test.ts';
const T_EXP = 'test/nightChargeExpectedBuy.test.ts';
const T_NOPLAN = 'test/noPlanReason.test.ts';
const T_MQTT = 'test/nightChargeMqtt.test.ts';
const T_FCC = 'test/forceChargeFailedCore.test.ts';
const T_FCON = 'test/forceChargeOn.test.ts';
const T_PV = 'test/costCeilingPvDebias.test.ts';
const T_LEDGER = 'test/ledgerCostSurplus.test.ts';
const T_MIDANN = 'test/middayAnnounce.test.ts';

const MUTANTS = [
  /* ── S: the write setpoint is the leg's own arm test ── */
  {
    id: 'S-i. ★★★ the pack-at-close leg solves its setpoint on the whole-house walk again (the defect)',
    file: NCA, tests: [T_SET, T_EXP],
    find: '  } else if (!setpointOnWalk) {',
    to: '  } else if (false) { /* MUTANT */',
    why: 'Every charge night asks 100% and writes the 50% maximum: ~18 kWh of pack above what the plan is sized on.',
  },
  {
    id: 'S-ii. ★★★ the line is asked at one decimal, not the whole percent above it',
    file: NCA, tests: [T_SET],
    find: '    ? Math.min(100, Math.ceil((targetFloorKwh / fullKwh) * 100 - 1e-9)) : 0;',
    to: '    ? Math.min(100, round1((targetFloorKwh / fullKwh) * 100)) : 0; /* MUTANT */',
    why: 'clampReserveTarget rounds: a 30.45% line is written as 30, under the line the plan was sized on.',
  },
  {
    id: 'S-iii. ★★★ the line ask is left out of the setpoint',
    file: NCA, tests: [T_SET],
    find: '    lineAskPct,\n  );',
    to: '    0, /* MUTANT */\n  );',
    why: 'The setpoint is the arrival to one decimal: written under the line on any night whose arrival rounds down.',
  },
  {
    id: 'S-iv. ★★★ a mid-day leg leaves the walk: T_mid\'s R becomes the line',
    file: NCA, tests: [T_MID],
    find: "  const setpointOnWalk = midday || backupLeg || cushionBasis === 'legacy-pct';",
    to: "  const setpointOnWalk = backupLeg || cushionBasis === 'legacy-pct'; /* MUTANT */",
    why: 'The mid-day reserve carries no resilience lift: R (≈37.5%) drops to the line.',
  },
  {
    id: 'S-v. ★★★ the backup leg leaves the walk its arm test is',
    file: NCA, tests: [T_MID, T_SET],
    find: "  const setpointOnWalk = midday || backupLeg || cushionBasis === 'legacy-pct';",
    to: "  const setpointOnWalk = midday || cushionBasis === 'legacy-pct'; /* MUTANT */",
    why: 'The backup arms on the walk to 23:00 and writes the line: the walk it armed for is not held.',
  },
  {
    id: 'S-vi. ★★★ a cost night\'s setpoint is the line, not the cost target',
    file: NCA, tests: [T_SET],
    find: '    requiredPackAtWindowEndKwh = Math.min(fullKwh, Math.max(targetFloorKwh, costMode ? (costTargetKwh ?? 0) : 0));',
    to: '    requiredPackAtWindowEndKwh = Math.min(fullKwh, Math.max(targetFloorKwh, 0)); /* MUTANT */',
    why: 'A charge-rate-bound cost night writes the derated arrival (35%), not its 40.3% target: the device stops short at full rate.',
  },
  {
    id: 'S-vii. ★★ the cost target is named as a resilience requirement',
    file: NCA, tests: [T_SET],
    find: '  const askIsCost = baselineHolds || (!setpointOnWalk && costMode && costTargetKwh != null\n    && round1((costTargetKwh / fullKwh) * 100) > lineAskPct);',
    to: '  const askIsCost = baselineHolds; /* MUTANT */',
    why: '"The resilience requirement asks for 90%" on a night whose resilience need is a 31% line.',
  },
  {
    id: 'S-viii. ★★ a whole-percent write is called the envelope',
    file: NCA, tests: [T_SET],
    find: '  const truncated = setpointSocPct > RESERVE_WRITE_MAX_PCT + 0.05;',
    to: '  const truncated = setpointSocPct > writtenPct + 0.05; /* MUTANT */',
    why: '"Asks for 40.3%, but the panel only accepts a backup reserve up to 50%" for a 40% write.',
  },
  {
    id: 'S-ix. ★★★ the legacy band leaves the walk',
    file: NCA, tests: [T_SET],
    find: "  const setpointOnWalk = midday || backupLeg || cushionBasis === 'legacy-pct';",
    to: '  const setpointOnWalk = midday || backupLeg; /* MUTANT */',
    why: 'The legacy band arms on the whole-house trough and writes its flat line: the trough it armed for is not held.',
  },

  /* ── F: the ON-failure warning names the Core ── */
  {
    id: 'F-i. ★★★ a setting the other Cores share is named as a difference',
    file: NFC, tests: [T_FCC],
    find: '      if (v == null || theirs.length === 0 || theirs.includes(v)) return;',
    to: '      if (v == null) return; /* MUTANT */',
    why: 'Every failure names "work mode 0, where the other Cores read 0": noise that hides the real one.',
  },
  {
    id: 'F-ii. ★★★ the failed slot is compared with itself',
    file: NFC, tests: [T_FCC],
    find: '    .filter((n) => !failed.includes(n))',
    to: '    .filter(() => true) /* MUTANT */',
    why: 'Core 5\'s own mode is among "the other Cores\'": the 10-06 clause vanishes.',
  },
  {
    id: 'F-iii. ★★ the work mode is read from the reserve field',
    file: NFC, tests: [T_FCC],
    find: '      workMode: fin(pj?.sysWordMode),',
    to: '      workMode: fin(pj?.sysBackupSoc), /* MUTANT */',
    why: '"Work mode 60" — a reserve reported as a mode.',
  },
  {
    id: 'F-iv. ★★ mode 3 named as scheduled',
    file: NFC, tests: [T_FCC],
    find: "  0: 'default', 1: 'self-powered', 2: 'scheduled', 3: 'time-of-use',",
    to: "  0: 'default', 1: 'self-powered', 2: 'scheduled', 3: 'scheduled', /* MUTANT */",
    why: 'The 10-06 Core\'s time-of-use mode is misnamed.',
  },
  {
    id: 'F-v. ★★ an offline Core is not said to be offline',
    file: NFC, tests: [T_FCC],
    find: "    if (c.online === false) notes.push('offline in the cloud');",
    to: '    /* MUTANT */',
    why: 'Its last-reported settings read as current.',
  },
  {
    id: 'F-vi. ★★★ a fallback-named Core is labelled by its product name, not its slot',
    file: NFC, tests: [T_FCC],
    find: '      label: dev != null ? coreLabel(coreNumber(dev, devices), dev.deviceName) : null,',
    to: '      label: dev != null ? dev.deviceName : null, /* MUTANT */',
    why: '"3 (DELTA Pro Ultra …)": two unnamed Cores read identically.',
  },
  {
    id: 'F-vii. ★★ the hint to compare the Core\'s settings is never given',
    file: NOTIFY, tests: [T_FCC],
    find: "  const compare = named.differing === 0 ? ''",
    to: "  const compare = true ? '' /* MUTANT */",
    why: 'The warning names the difference and says only "check the SHP2 cloud link".',
  },
  {
    id: 'F-viii. ★★★ the push is not given the Cores',
    file: IDX, tests: [T_FCC, T_FCON],
    find: '        cores: slotCores,\n',
    to: '        /* MUTANT */\n',
    why: 'The warning reads slot numbers only, as on 10-06.',
  },
  {
    id: 'F-ix. ★★ the log line names slot numbers only',
    file: IDX, tests: [T_FCC],
    find: 'ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF',
    to: "ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${action.slots.join(',')} still read FORCE_CHARGE_OFF /* MUTANT */",
    why: 'The journal, read after the fact, has the slot number and not the Core.',
  },
  {
    id: 'F-x. ★★ "the other Cores" are every listed slot, not ours',
    file: NFC, tests: [T_FCC],
    find: '  const others = (ours ?? cores.map((c) => c.slot))',
    to: '  const others = (cores.map((c) => c.slot)) /* MUTANT */',
    why: 'A listed Core the force-charge does not drive shares the failed Core\'s mode: the difference among ours is hidden.',
  },

  /* ── N: the no-plan push names the gate ── */
  {
    id: 'N-i. ★★★ a refused plan carries no basisBlockedBy (the defect)',
    file: NCA, tests: [T_NOPLAN],
    find: '    ...(basisComplete ? {} : { basisBlockedBy: blockedBy }),',
    to: '    ...{}, /* MUTANT */',
    why: 'Declared and never set: the push is the fixed sentence again.',
  },
  {
    id: 'N-ii. ★★★ every plan carries basisBlockedBy',
    file: NCA, tests: [T_NOPLAN],
    find: '    ...(basisComplete ? {} : { basisBlockedBy: blockedBy }),',
    to: '    ...({ basisBlockedBy: blockedBy }), /* MUTANT */',
    why: 'Every charge and hold plan\'s JSON gains a null key.',
  },
  {
    id: 'N-iii. ★★★ the input gate\'s reason is dropped',
    file: NCA, tests: [T_NOPLAN],
    find: '    return nullPlan(inputs, false, `No plan — forecast/telemetry basis incomplete${why}; nothing will be charged.`, inputs.basisTransient === true, inputs.basisBlockedBy ?? null);',
    to: '    return nullPlan(inputs, false, `No plan — forecast/telemetry basis incomplete${why}; nothing will be charged.`, inputs.basisTransient === true, null); /* MUTANT */',
    why: 'The 2026-09-10 coverage miss is pushed as "basis incomplete" with no reason.',
  },
  {
    id: 'N-iv. ★★ the planner\'s own preconditions name no reason',
    file: NCA, tests: [T_NOPLAN],
    find: '    nullPlan(inputs, false, `No plan — ${why}${tail}.`, transient, why);',
    to: '    nullPlan(inputs, false, `No plan — ${why}${tail}.`, transient, null); /* MUTANT */',
    why: 'Incoherent SoC telemetry is pushed as a forecast problem.',
  },
  {
    id: 'N-v. ★★★ the push leaves the reason out',
    file: NOTIFY, tests: [T_NOPLAN],
    find: "      : `the forecast/telemetry basis is incomplete${plan.basisBlockedBy ? `: ${plan.basisBlockedBy}` : ''}`;",
    to: "      : `the forecast/telemetry basis is incomplete${''}`; /* MUTANT */",
    why: 'The reason is on the plan and in no message.',
  },
  {
    id: 'N-vi. ★★ a null plan is called an incomplete basis',
    file: NOTIFY, tests: [T_NOPLAN, T_MQTT],
    find: "      ? \"the panel's pool readings (capacity, state of charge, reserve) are unavailable\"",
    to: "      ? 'the forecast/telemetry basis is incomplete' /* MUTANT */",
    why: 'A night with no panel reading reads as a forecast failure.',
  },
  {
    id: 'N-vii. ★★★ the mid-day "no plan" push leaves the reason out',
    file: CTEXT, tests: [T_MIDANN, T_NOPLAN],
    find: "    const blocked = c.basisBlockedBy ? `: ${c.basisBlockedBy}` : '';",
    to: "    const blocked = ''; /* MUTANT */",
    why: 'Once the switch routes the evening to the mid-day words, the defect is back for mid-day nights.',
  },
  {
    id: 'N-viii. ★★★ the shadow leg drops the gate',
    file: SHADOW, tests: [T_NOPLAN],
    find: '      ? { basisBlockedBy: p.basisBlockedBy } : {}),',
    to: '      ? {} : {}), /* MUTANT */',
    why: 'The record names the gate in its disposition only; the preview push is the fixed sentence.',
  },
  {
    id: 'N-ix. ★★ the shadow leg keeps a gate on a complete plan',
    file: SHADOW, tests: [T_NOPLAN],
    find: "    ...(p != null && !p.basisComplete && typeof p.basisBlockedBy === 'string' && p.basisBlockedBy !== ''",
    to: "    ...(p != null && typeof p.basisBlockedBy === 'string' && p.basisBlockedBy !== '' /* MUTANT */",
    why: 'Inert today (a complete plan has no key); pins the guard should a plan ever carry one.',
  },
  {
    id: 'N-x. ★★★ the announce input does not pass the gate',
    file: SHADOW, tests: [T_MIDANN, T_NOPLAN],
    find: '      basisBlockedBy: c.basisComplete ? null : (c.basisBlockedBy ?? null),',
    to: '      basisBlockedBy: null, /* MUTANT */',
    why: 'The record has the gate and the push does not.',
  },
  {
    id: 'N-xi. ★★ a complete leg passes a stale gate',
    file: SHADOW, tests: [T_MIDANN],
    find: '      basisBlockedBy: c.basisComplete ? null : (c.basisBlockedBy ?? null),',
    to: '      basisBlockedBy: c.basisBlockedBy ?? null, /* MUTANT */',
    why: 'A record field the builder reads only on an incomplete basis; pinned so a complete leg never names one.',
  },
  {
    id: 'N-xii. ★★ the gate is lost when the record is read back',
    file: SHADOW, tests: [T_MIDANN],
    find: "    ...(typeof o.basisBlockedBy === 'string' && o.basisBlockedBy !== '' ? { basisBlockedBy: o.basisBlockedBy } : {}),",
    to: '    /* MUTANT */',
    why: 'A restart between the evening and the preview drops the reason.',
  },

  /* ── P: the cost ceiling's PV de-bias ── */
  {
    id: 'P-i. ★★★ the PV factor may shrink the sun',
    file: NCA, tests: [T_PV],
    find: '  const factor = Math.max(1, Math.min(COST_SURPLUS_PV_FACTOR_MAX, 1 + weight * (median - 1)));',
    to: '  const factor = Math.min(COST_SURPLUS_PV_FACTOR_MAX, 1 + weight * (median - 1)); /* MUTANT */',
    why: 'A ledger at −20% shrinks the surplus: the ceiling and the buy rise.',
  },
  {
    id: 'P-ii. ★★ the PV factor is unbounded',
    file: NCA, tests: [T_PV],
    find: '  const factor = Math.max(1, Math.min(COST_SURPLUS_PV_FACTOR_MAX, 1 + weight * (median - 1)));',
    to: '  const factor = Math.max(1, 1 + weight * (median - 1)); /* MUTANT */',
    why: 'A ledger at +60% counts the sun at ×1.6.',
  },
  {
    id: 'P-iii. ★★★ an hour\'s de-biased P50 passes its own P90',
    file: NCA, tests: [T_PV],
    find: '  return Math.min(p50W * factor, Math.max(p50W, Number.isFinite(p90W) ? p90W : p50W));',
    to: '  return p50W * factor; /* MUTANT */',
    why: '7800 W against a 7500 W best case.',
  },
  {
    id: 'P-iv. ★★★ a saturated day is a sample',
    file: NCA, tests: [T_PV],
    find: "    .filter((r) => r.confidence_tier === 'forecast' && r.pv_verdict_set_aside == null && r.pv_saturated !== 1)",
    to: "    .filter((r) => r.confidence_tier === 'forecast' && r.pv_verdict_set_aside == null) /* MUTANT */",
    why: 'A curtailed day\'s actual is read as the sun.',
  },
  {
    id: 'P-v. ★★★ a set-aside verdict is a sample',
    file: NCA, tests: [T_PV],
    find: "    .filter((r) => r.confidence_tier === 'forecast' && r.pv_verdict_set_aside == null && r.pv_saturated !== 1)",
    to: "    .filter((r) => r.confidence_tier === 'forecast' && r.pv_saturated !== 1) /* MUTANT */",
    why: 'A band built for other Cores is graded against these.',
  },
  {
    id: 'P-vi. ★★ a non-forecast-tier row is a sample',
    file: NCA, tests: [T_PV],
    find: "    .filter((r) => r.confidence_tier === 'forecast' && r.pv_verdict_set_aside == null && r.pv_saturated !== 1)",
    to: "    .filter((r) => r.pv_verdict_set_aside == null && r.pv_saturated !== 1) /* MUTANT */",
    why: 'A climatology night\'s ratio is no forecast skill.',
  },
  {
    id: 'P-vii. ★★ a near-dark forecast is a sample',
    file: NCA, tests: [T_PV],
    find: '    .filter((r) => typeof r.pv_p50_kwh === \'number\' && Number.isFinite(r.pv_p50_kwh) && r.pv_p50_kwh >= COST_SURPLUS_PV_MIN_FORECAST_KWH)',
    to: '    .filter((r) => typeof r.pv_p50_kwh === \'number\' && Number.isFinite(r.pv_p50_kwh) && r.pv_p50_kwh >= 0) /* MUTANT */',
    why: 'A 0.5 kWh forecast\'s ×20 ratio enters the median.',
  },
  {
    id: 'P-viii. ★★★ a PV-only ledger builds nothing (the defect)',
    file: NCA, tests: [T_PV],
    find: '  if (!(cal.factor < 1) && !(pv.factor > 1)) return null;',
    to: '  if (!(cal.factor < 1)) return null; /* MUTANT */',
    why: 'A ledger whose load ran to forecast never de-biases the sun.',
  },
  {
    id: 'P-ix. ★★★ the builder sums the surplus with the P50 as forecast',
    file: NCA, tests: [T_PV],
    find: '    cal.factor,\n    pv.factor,\n  );',
    to: '    cal.factor,\n    1, /* MUTANT */\n  );',
    why: 'The factor is reported and not applied.',
  },
  {
    id: 'P-x. ★★ the P90 stand-in is scaled too',
    file: NCA, tests: [T_PV],
    find: '    p90Kwh += Math.max(0, h.p90W - loadW) / 1000;',
    to: '    p90Kwh += Math.max(0, costSurplusPvW(h.p90W, h.p90W * 2, pvFactor) - loadW) / 1000; /* MUTANT */',
    why: 'The band\'s best case is raised past itself.',
  },
  {
    id: 'P-xi. ★★ the plan does not report the PV factor',
    file: NCA, tests: [T_PV],
    find: '    costSurplusPvFactor: costLoad != null && !longGap ? (costLoad.pvFactor ?? 1) : null,',
    to: '    costSurplusPvFactor: null, /* MUTANT */',
    why: 'A ceiling lowered by the sun cannot be audited.',
  },
  {
    id: 'P-xii. ★★ the rationale does not say the sun was de-biased',
    file: NCA, tests: [T_PV],
    find: '    ...((costLoad.pvFactor ?? 1) > 1 ? [`the median sun at ×${costLoad.pvFactor} of its forecast from ${costLoad.pvSamples ?? 0} realized nights`] : []),',
    to: '    ...([]), /* MUTANT */',
    why: 'The headroom note disappears on a PV-only de-bias.',
  },
  {
    id: 'P-xiii. ★★ the ledger column is never written',
    file: NCA, tests: [T_PV],
    find: '    cost_surplus_pv_factor: plan.costSurplusPvFactor ?? null,',
    to: '    cost_surplus_pv_factor: null, /* MUTANT */',
    why: 'The factor behind a row\'s ceiling is lost.',
  },
  {
    id: 'P-xiv. ★★★ no day is ever saturated',
    file: NLS, tests: [T_PV],
    find: '  return { actual_max_soc_pct: Math.round(max * 10) / 10, pv_saturated: max >= taperPct ? 1 : 0 };',
    to: '  return { actual_max_soc_pct: Math.round(max * 10) / 10, pv_saturated: 0 }; /* MUTANT */',
    why: 'Every curtailed day enters the PV factor.',
  },
  {
    id: 'P-xv. ★★ a lone reconnect sample marks a day saturated',
    file: NLS, tests: [T_PV],
    find: '  for (const p of medianFilter3(o.socPts)) {',
    to: '  for (const p of o.socPts) { /* MUTANT */',
    why: 'A spike to 100% removes a clear day from the factor.',
  },
  {
    id: 'P-xvi. ★★ a re-captured row keeps its old saturation',
    file: NLS, tests: [T_PV],
    find: '    actual_max_soc_pct: null,\n    pv_saturated: null,\n',
    to: '    /* MUTANT */\n',
    why: 'The saturation measured on held readings outlives the reset.',
  },
  {
    id: 'P-xvii. ★★★ the capture does not write the saturation',
    file: IDX, tests: [T_PV],
    find: '    ...pvSaturation,\n',
    to: '    /* MUTANT */\n',
    why: 'pv_saturated stays NULL on every row: the censoring guard never fires.',
  },
  {
    id: 'P-xviii. ★★★ pv_saturated is not in the ledger allowlist',
    file: REC, tests: [T_LEDGER],
    find: "  'cost_surplus_pv_factor', 'cost_surplus_pv_samples', 'actual_max_soc_pct', 'pv_saturated',",
    to: "  'cost_surplus_pv_factor', 'cost_surplus_pv_samples', 'actual_max_soc_pct', /* MUTANT */",
    why: 'The write is dropped silently.',
  },
  {
    id: 'P-xix. ★★★ the PV factor column is never added to an existing ledger',
    file: REC, tests: [T_LEDGER],
    find: "    'cost_surplus_pv_factor REAL', 'cost_surplus_pv_samples INTEGER', 'actual_max_soc_pct REAL', 'pv_saturated INTEGER',",
    to: "    'cost_surplus_pv_samples INTEGER', 'actual_max_soc_pct REAL', 'pv_saturated INTEGER', /* MUTANT */",
    why: 'Every plan row write fails on the deployed database.',
  },
  {
    id: 'P-xx. ★★★ the ramp is not capped at ten nights',
    file: NCA, tests: [T_PV],
    find: '  const weight = Math.min(1, samples / COST_SURPLUS_LOAD_FULL_SAMPLES);',
    to: '  const weight = samples / COST_SURPLUS_LOAD_FULL_SAMPLES; /* MUTANT */',
    why: 'Fourteen nights at +10% count the sun at ×1.14: past what the ledger measured, the ceiling and the stop lower than it supports.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1196-night', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
