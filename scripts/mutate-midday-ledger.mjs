#!/usr/bin/env node
/**
 * mutate-midday-ledger.mjs — R4 (v1.189.0): the winter mid-day cycle in SHADOW, and the ledger it
 * will be judged on (plan §6, §7). Both legs are computed on the evenings before a winter weekday
 * and at the morning refresh, and NOTHING of them is written, armed, pushed or announced
 * (middayShadow.ts, index.ts's shadow block); the overnight leg runs as before. The ledger learns
 * a two-leg row's three spans, its cheap periods and its supersede; the buy de-bias one stratum
 * per window kind; the gate a graduation count per kind; and the hours a mid-day charge of ours
 * held the pool leave the array learners.
 *
 *   Spans      L-i..L-vii    (cycleLedgerSpans, ledgerCheapPeriodIds, supersedingPlanDate, minOverSpans)
 *   Measured   L-viii..L-ix  (shadowWindowActuals)
 *   Accounting L-x..L-xiv    (middayChargeHourEpochs, withoutHourEpochs, the three learners)
 *   Scorer     L-xv..L-xviii (index.ts: the two-leg spans, the trough, the shadow's window)
 *   Learners   L-xix..L-xxii (the de-bias stratum, NULL as overnight, the refreshed figure, the call site)
 *   Gate       L-xxiii
 *   Recorder   L-xxiv..L-xxv (the shadow columns: the ALTER pass and the allowlist)
 *   Held       L-xxvi..L-xxx (on v1.188.1: the shadow's window on the held verdict, per side, over
 *                             the window; the held reset clears its measured window; the call site)
 *   No write   S-i..S-xiii   (the plan holder, the snapshot, the arm probe, the entities, the stamp,
 *                             the latch, the stale panel, the re-read, the order, the status)
 *   Shadow     S-xiv..S-xxii (the refresh never raises, the tag, the backup's one walk and option A,
 *                             the hold, advisory, the served record)
 *   Basis      B-i..B-v      (every mid-day figure carries basis=shadow; the backup's line says
 *                             "Shadow only"; the card's not-comparable line)
 *   Review     U-i..U-iv     (v1.190.1: the window bounds are timestamp sensors whose null is the
 *                             "None" payload; the text sensors render a null as "unknown")
 *              L-xxxi..xxxii (no measured shadow PV on a row whose PV verdict is set aside)
 *
 *   node scripts/mutate-midday-ledger.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const GATE = resolve(REPO, 'server/src/nightChargeGate.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const MS = resolve(REPO, 'server/src/middayShadow.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
const WEBTXT = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const SUBSET = [
  'test/middayShadow.test.ts',
  'test/ledgerMiddayShadow.test.ts',
  'test/middayShadowCard.test.ts',
  'test/middayPlan.test.ts',
  'test/legacyIdentity.test.ts',
  'test/nightPlanPanelFreshness.test.ts',
  'test/buyDebiasCalibration.test.ts',
  'test/readinessGate.test.ts',
  'test/ledgerOnPeakGoverned.test.ts',
  'test/nightChargeMqtt.test.ts',
  'test/mqttDiscovery.test.ts',
  'test/ledgerHeldMiddayShadow.test.ts',
];

const MUTANTS = [
  /* ── a two-leg row's spans ── */
  {
    id: 'L-i. ★★★ the post span runs close + 16 h (to 07:00), not to the next chargeable open',
    file: NLS,
    find: '  const postEnd = typeof next === \'number\' && Number.isFinite(next) && next > we ? Math.min(capEnd, next) : capEnd;',
    to: '  const postEnd = capEnd; /* MUTANT */',
    why: 'Rows overlap: the next row\'s backup span is scored twice, and a breach strikes two cycles.',
  },
  {
    id: 'L-ii. ★★★ a two-leg row skips its backup span',
    file: NLS,
    find: '  if (typeof bs === \'number\' && Number.isFinite(bs) && bs < ws) troughSpans.push({ startMs: bs, endMs: ws });',
    to: '  /* MUTANT */',
    why: 'The 05:00–10:00 low falls in no row: a 07:00 breach is never a strike.',
  },
  {
    id: 'L-iii. ★★★ the on-peak attribution counts the overnight period only on a two-leg row',
    file: NLS,
    find: "  return windowKind === 'super_off_peak' ? [...own, 'super_off_peak'] : own;",
    to: "  return own; /* MUTANT */",
    why: 'A mid-day window does not end the claim of the plan before it.',
  },
  {
    id: 'L-iv. ★★★ every row takes the two-leg spans',
    file: NLS,
    find: "  if (row.window_kind !== 'super_off_peak') return null;",
    to: '  /* MUTANT */',
    why: 'Every overnight row scored today changes its spans: the trough ends at the next open.',
  },
  {
    id: "L-v. ★★★ a later row's backup window does not supersede",
    file: NLS,
    find: '    if (!sameWindow && !asBackup) continue;',
    to: '    if (!sameWindow) continue; /* MUTANT */',
    why: "Saturday's arm and Sunday's backup both claim Monday's on-peak and its cost.",
  },
  {
    id: 'L-vi. ★★ an earlier row\'s backup supersedes a later one',
    file: NLS,
    find: '    if (d <= own) continue;\n    // R4',
    to: '    // R4 /* MUTANT */',
    why: 'A row is superseded by itself, or by an earlier plan.',
  },
  {
    id: 'L-vii. ★★★ the trough over several spans takes the raw minimum (no spike filter)',
    file: NLS,
    find: '    for (const p of filter(query(sp.startMs, sp.endMs))) {',
    to: '    for (const p of query(sp.startMs, sp.endMs)) { /* MUTANT */',
    why: 'A reconnect\'s lone 0% sample is recorded as the night\'s low and a cushion breach.',
  },

  /* ── the shadow's window, measured ── */
  {
    id: 'L-viii. ★★★ the shadow\'s PV is summed across a dark Core',
    file: NLS,
    find: '    pvKwh = worst >= LEDGER_SPAN_MIN_COVERAGE ? round2(pvEnergyWh / 1000) : null;',
    to: '    pvKwh = round2(pvEnergyWh / 1000); /* MUTANT */',
    why: 'A third of the fleet\'s PV is recorded as the window\'s forecast skill.',
  },
  {
    id: 'L-ix. ★★ the shadow\'s window is measured before it closes',
    file: NLS,
    find: "  if (typeof a !== 'number' || typeof b !== 'number' || !(b > a) || i.nowMs < b) return null;",
    to: "  if (typeof a !== 'number' || typeof b !== 'number' || !(b > a)) return null; /* MUTANT */",
    why: 'A partial window is frozen into the row.',
  },

  /* ── plan §4 item 9, the accounting part ── */
  {
    id: 'L-x. ★★★ overnight rows drop their hours from the array learners',
    file: NLS,
    find: "    if (r.window_kind !== 'super_off_peak') continue;\n    const wrote",
    to: '    const wrote /* MUTANT */',
    why: 'Every learner changes today on hours with no sun; the night-charge rows reach the solar fit.',
  },
  {
    id: 'L-xi. ★★ a mid-day leg that never wrote drops its hours',
    file: NLS,
    find: '    if (!wrote) continue;',
    to: '    /* MUTANT */',
    why: 'An armed, cancelled or missed day loses its PV evidence for nothing.',
  },
  {
    id: 'L-xii. ★★ withoutHourEpochs keeps only the charge hours',
    file: NLS,
    find: '  for (const [he, v] of map) if (!drop.has(he)) out.set(he, v);',
    to: '  for (const [he, v] of map) if (drop.has(he)) out.set(he, v); /* MUTANT */',
    why: 'The soiling estimate reads only the hours it must not.',
  },
  {
    id: 'L-xiii. ★★★ the soiling estimate reads the charge hours',
    file: AN,
    find: 'soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps.map((m) => withoutHourEpochs(m, chargeHours)), wxByHour,',
    to: 'soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps /* MUTANT */, wxByHour,',
    why: 'A mid-day grid charge that sheds PV reads as dirty panels.',
  },
  {
    id: 'L-xiv. ★★★ the Bayesian posterior and the PV bias hindcast read the charge hours',
    file: AN,
    find: '    if (chargeHours.has(he)) continue;',
    to: '    /* MUTANT */',
    why: 'The curtailment detector\'s expected PV learns the shed hours as the array\'s output.',
  },

  /* ── the scorer (index.ts) ── */
  {
    id: 'L-xv. ★★★ the scorer drops a two-leg row\'s trough spans',
    file: IDX,
    find: 'windowKnown: true, troughSpans: cycle.troughSpans,',
    to: 'windowKnown: true, /* MUTANT */',
    why: 'A two-leg row\'s low is read over nothing: actual_min_soc_pct is NULL, no strike can fire.',
  },
  {
    id: 'L-xvi. ★★★ the scorer reads the post span only',
    file: IDX,
    find: '  if (s.troughSpans != null) {\n    const low = minOverSpans(',
    to: '  if (s.troughSpans != null && (false as boolean)) { /* MUTANT */\n    const low = minOverSpans(',
    why: 'The 07:00 breach after an unarmed backup is never a strike.',
  },
  {
    id: 'L-xvii. ★★ the scorer counts the overnight period only for a two-leg row',
    file: IDX,
    find: '      (t) => cheapIds.includes(rateAt(tariff, t).periodId),',
    to: '      (t) => cheapId != null && rateAt(tariff, t).periodId === cheapId, /* MUTANT */',
    why: 'As L-iii, at the scorer.',
  },
  {
    id: 'L-xviii. ★★★ the shadow\'s window is never measured',
    file: IDX,
    find: '    recorder.recordNightOutcome(yDate, { shadow_window_pv_kwh: shadowActuals.pvKwh, shadow_window_load_kwh: shadowActuals.loadKwh });',
    to: '    /* MUTANT */',
    why: 'The shadow has no forecast skill to show at the gate before the switch.',
  },

  /* ── the learners ── */
  {
    id: 'L-xix. ★★★ the buy de-bias pools the window kinds',
    file: NCA,
    find: '    .filter((r) => ledgerRowWindowKind(r) === stratum)\n',
    to: '    /* MUTANT */\n',
    why: 'Mid-day nights, charged beside the sun, move the overnight announcement.',
  },
  {
    id: 'L-xx. ★★★ a row with no window kind is not overnight',
    file: NCA,
    find: "  return r.window_kind === 'super_off_peak' ? 'super_off_peak' : 'overnight';",
    to: "  return r.window_kind === 'overnight' ? 'overnight' : 'super_off_peak'; /* MUTANT */",
    why: 'Every row written before the cycle record leaves the overnight learner: its factor resets.',
  },
  {
    id: 'L-xxi. ★★ the de-bias ignores the refreshed worst case',
    file: NCA,
    find: "    typeof r.refreshed_buy_kwh === 'number' && Number.isFinite(r.refreshed_buy_kwh) ? r.refreshed_buy_kwh : r.buy_kwh;",
    to: '    r.buy_kwh; /* MUTANT */',
    why: 'A refreshed leg is graded on the evening figure it did not run on.',
  },
  {
    id: 'L-xxii. ★★★ the live plan reads the mid-day stratum',
    file: IDX,
    find: "    { windowKind: shadowLeg?.spec.kind ?? 'overnight' },",
    to: "    { windowKind: 'super_off_peak' }, /* MUTANT */",
    why: 'The overnight announcement loses its calibration.',
  },

  /* ── the gate ── */
  {
    id: 'L-xxiii. ★★ the overnight graduation count drops the rows written before the cycle record',
    file: GATE,
    find: "    actuatedNightsOvernight: actuated.filter((r) => r.window_kind !== 'super_off_peak').length,",
    to: "    actuatedNightsOvernight: actuated.filter((r) => r.window_kind === 'overnight').length, /* MUTANT */",
    why: 'Every night actuated before v1.189.0 counts toward neither kind.',
  },

  /* ── the recorder ── */
  {
    id: 'L-xxiv. ★★★ the shadow columns are never added to an existing ledger',
    file: REC,
    find: '    ...MIDDAY_SHADOW_LEDGER_SCHEMA.map(([c, t]) => `${c} ${t}`),',
    to: '    /* MUTANT */',
    why: 'Every shadow write fails on the live database.',
  },
  {
    id: 'L-xxv. ★★★ the shadow columns are not in the allowlist',
    file: REC,
    find: '  ...MIDDAY_SHADOW_LEDGER_SCHEMA.map(([c]) => c),',
    to: '  /* MUTANT */',
    why: 'Every shadow write is dropped silently.',
  },

  /* ── on v1.188.1: held telemetry ── */
  {
    id: 'L-xxvi. ★★★ the shadow\'s window integrates a held Core',
    file: NLS,
    find: '    if (held.pv) pvKwh = null;',
    to: '    /* MUTANT */',
    why: 'Hours of a replayed reading are recorded as the mid-day window\'s forecast skill.',
  },
  {
    id: 'L-xxvii. ★★★ the shadow\'s window integrates a held panel',
    file: NLS,
    find: '  const loadKwh = !held.load && load.length > 0 && coverageFrac(load, a, b) >= LEDGER_SPAN_MIN_COVERAGE',
    to: '  const loadKwh = load.length > 0 && coverageFrac(load, a, b) >= LEDGER_SPAN_MIN_COVERAGE /* MUTANT */',
    why: 'The house load the panel replayed is graded as measured.',
  },
  {
    id: 'L-xxviii. ★★ the held verdict is taken over an instant, not the window',
    file: NLS,
    find: '    spans: i.held.spans(a, b), coreSns: i.homeSns, panelSn: i.held.panelSn, span: { startMs: a, endMs: b },',
    to: '    spans: i.held.spans(a, b), coreSns: i.homeSns, panelSn: i.held.panelSn, span: { startMs: a, endMs: a + 1 }, /* MUTANT */',
    why: 'No hold inside the window ever reaches the verdict.',
  },
  {
    id: 'L-xxix. ★★★ the held reset keeps the shadow\'s measured window',
    file: NLS,
    find: '    shadow_window_pv_kwh: null,\n    shadow_window_load_kwh: null,\n',
    to: '    /* MUTANT */\n',
    why: 'A row reset for held telemetry keeps the window figures measured on the held readings.',
  },
  {
    id: 'L-xxx. ★★★ the scorer measures the shadow\'s window with no held spans',
    file: IDX,
    find: '    held: { spans: (a, b) => recorder.heldSpans?.(a, b) ?? [], panelSn: shp2Sn },',
    to: '    /* MUTANT */',
    why: 'The verdict is never given a span: every held hour reaches the window\'s figures.',
  },

  /* ── nothing is written for the mid-day leg ── */
  {
    id: 'S-i. ★★★ a shadow leg becomes the latest plan',
    file: IDX,
    find: '  if (!shadowLeg) setLatestNightChargePlan(plan);',
    to: '  setLatestNightChargePlan(plan); /* MUTANT */',
    why: 'The night-charge entities, the card and an advisory automation read the mid-day plan as tonight\'s.',
  },
  {
    id: 'S-ii. ★★★ a shadow leg is persisted as the plan snapshot',
    file: IDX,
    find: '  if (!shadowLeg && plan.window && nowMs < plan.window.startMs) {',
    to: '  if (plan.window && nowMs < plan.window.startMs) { /* MUTANT */',
    why: 'A restart records the mid-day leg as the night\'s plan row.',
  },
  {
    id: 'S-iii. ★★★ a shadow leg is not a shadow leg',
    file: IDX,
    find: '  const shadowLeg = opts.shadowLeg ?? null;',
    to: '  const shadowLeg = null as ShadowLegSizing | null; /* MUTANT */',
    why: 'The shadow plans the overnight leg, sets it as the latest plan and persists it.',
  },
  {
    id: 'S-iv. ★★★ the arm probe persists the cycle it built',
    file: IDX,
    find: '    return { armed: verdict.legs.map((l) => l.leg), refused: verdict.refused };',
    to: '    if (verdict.cycle) persistCycle(verdict.cycle); /* MUTANT */\n    return { armed: verdict.legs.map((l) => l.leg), refused: verdict.refused };',
    why: 'The mid-day legs are armed: the 10:00 write happens.',
  },
  {
    id: 'S-v. ★★★ the shadow is a recommendation',
    file: MS,
    find: "    midday_charge_recommended: false,\n    midday_charge_target_soc_percent: charges ? pick('levelPct') : null,",
    to: "    midday_charge_recommended: charges && rec!.cost!.wouldArm, /* MUTANT */\n    midday_charge_target_soc_percent: charges ? pick('levelPct') : null,",
    why: 'An advisory automation charges at 10:00 on a computation nobody armed.',
  },
  {
    id: 'S-vi. ★★★ the role entity reports the shadow\'s role',
    file: MQ,
    find: '      ...nightChargeRoleFields(getLatestNightChargePlan()),',
    to: "      ...nightChargeRoleFields(getLatestNightChargePlan(), Date.now(), getMiddayShadow()?.cost ? 'backup' : 'cost'), /* MUTANT */",
    why: 'An automation on charge_tonight skips tonight\'s real overnight charge as a mere backup.',
  },
  {
    id: 'S-vii. ★★★ a shadow stamp creates a ledger row',
    file: IDX,
    find: '    if (!recorder.readNightLedger(3).some((r) => r.plan_date === day)) {',
    to: '    if (false as boolean) { /* MUTANT */',
    why: 'A row of shadow columns alone reads as a night with no plan (an MNAR hole).',
  },
  {
    id: 'S-viii. ★★ the shadow runs before the live evening job latched',
    file: IDX,
    find: '  if (readNightChargeLatch().lastNotifyDay === today && cur?.day !== today && nowMin >= fireMin && nowMin < sched.eveningCutoffMin) {',
    to: '  if (cur?.day !== today && nowMin >= fireMin && nowMin < sched.eveningCutoffMin) { /* MUTANT */',
    why: 'The shadow competes with the live plan for the worker and the panel while the arm is pending.',
  },
  {
    id: 'S-ix. ★★ the refresh sizes on a stale panel',
    file: IDX,
    find: '    const sized = await sizeShadowLeg(sizing, false);',
    to: '    const sized = await sizeShadowLeg(sizing, true); /* MUTANT */',
    why: 'The refresh records a re-plan made on a reading it would refuse live.',
  },
  {
    id: 'S-x. ★★ the refresh is not re-read after its await',
    file: IDX,
    find: '  if (live == null || live.day !== cur.day || live.computedAtMs !== cur.computedAtMs || live.refresh != null) return;',
    to: '  if (live == null) return; /* MUTANT */',
    why: 'A refresh computed for yesterday\'s record lands on tonight\'s.',
  },
  {
    id: 'S-xi. ★★ the refresh is logged before it is stamped',
    file: IDX,
    find: '  persistMiddayShadow(next); // stamped before anything is said about it (plan §3.4 step 4)\n  app.log.info(middayShadowRefreshLogLine(next, refresh));',
    to: '  app.log.info(middayShadowRefreshLogLine(next, refresh)); /* MUTANT */\n  persistMiddayShadow(next);',
    why: 'A restart between the two says a refresh happened that the record does not hold.',
  },
  {
    id: 'S-xii. ★★ the status serves a record whose window closed',
    file: IDX,
    find: '    middayShadow: shadowServed(getMiddayShadow(), Date.now()) ? getMiddayShadow() : null,',
    to: '    middayShadow: getMiddayShadow(), /* MUTANT */',
    why: 'The card shows yesterday\'s mid-day plan as today\'s.',
  },
  {
    id: 'S-xiii. ★★★ the entities outlive the window',
    file: MS,
    find: '  return rec != null && rec.cost != null && nowMs - rec.computedAtMs < MIDDAY_SHADOW_FRESH_MS && nowMs < rec.cost.windowEndMs;',
    to: '  return rec != null && rec.cost != null && nowMs - rec.computedAtMs < MIDDAY_SHADOW_FRESH_MS; /* MUTANT */',
    why: 'Past 15:00 the entities still state a charge that is over.',
  },

  /* ── the shadow's own rules ── */
  {
    id: 'S-xiv. ★★★ the refresh raises the level past the announced one',
    file: MS,
    find: '  const levelAbove = ceil != null && r.levelPct != null && r.levelPct > ceil + 1e-9;',
    to: '  const levelAbove = false; /* MUTANT */',
    why: 'The morning re-plan charges past the level the owner consented to.',
  },
  {
    id: 'S-xv. ★★★ the refresh writes a reserve above the announced level',
    file: MS,
    find: '  const reserveAbove = r.reservePct != null && ((ceil != null && r.reservePct > ceil + 1e-9)',
    to: '  const reserveAbove = r.reservePct != null && ((false as boolean) /* MUTANT */',
    why: 'As S-xiv, for the reserve.',
  },
  {
    id: 'S-xvi. ★★ a cap is not recorded',
    file: MS,
    find: '  if (levelAbove || reserveAbove) {',
    to: '  if ((false as boolean) && (levelAbove || reserveAbove)) { /* MUTANT */',
    why: 'A refresh that needed more than the consent reads as unchanged or lowered, and writes the raise.',
  },
  {
    id: 'S-xvi-b. ★★ a figure the re-plan does not give is raised to 50',
    file: MS,
    find: '  const reservePct = r.reservePct != null ? Math.min(50, r.reservePct) : a.reservePct;',
    to: '  const reservePct = r.reservePct != null ? r.reservePct : 50; /* MUTANT */',
    why: 'A re-plan with no setpoint holds the reserve at 50 over the announced 30.',
  },
  {
    id: 'S-xvii. ★★ the shadow log loses its tag',
    file: MS,
    find: "export const MIDDAY_SHADOW_LOG_TAG = 'night-charge[midday-shadow]:';",
    to: "export const MIDDAY_SHADOW_LOG_TAG = 'night-charge:'; /* MUTANT */",
    why: 'The shadow\'s lines read as the live night-charge\'s.',
  },
  {
    id: 'S-xviii. ★★★ the backup leg arms on the pack at its close, not on the walk it writes for',
    file: NCA,
    find: "    if (cushionBasis === 'legacy-pct' || backupLeg) return houseTroughAtLift(lift);",
    to: "    if (cushionBasis === 'legacy-pct') return houseTroughAtLift(lift); /* MUTANT */",
    why: 'From 80% the backup holds while its own walk to 23:00 dips under the line.',
  },
  {
    id: 'S-xix. ★★★ the backup leg walks to the cost open (option B), not the next overnight open',
    file: MS,
    find: '    nextRechargeMs: nextChargeableOpenMs(model, backup.endMs + HOUR_MS, OVERNIGHT_CYCLE),',
    to: '    nextRechargeMs: backup.endMs + 5 * HOUR_MS, /* MUTANT */',
    why: 'The owner\'s default (option A) is replaced by the cheaper, less protective option B.',
  },
  {
    id: 'S-xx. ★★★ the cost leg is sized as if no backup protected it',
    file: MS,
    find: '  const backupHold = holdPct != null && cycle.backup != null ? { pct: holdPct, untilMs: cycle.backup.endMs } : null;',
    to: '  const backupHold = null; /* MUTANT */',
    why: 'An armed-backup night states about 14 kWh too much for the mid-day leg.',
  },
  {
    id: 'S-xxi. ★★ the cost leg is anchored on a backup that would not arm',
    file: MS,
    find: '  const holdPct = backupArm?.wouldArm && backupSized?.plan.setpointSocPct != null',
    to: '  const holdPct = backupSized?.plan.setpointSocPct != null /* MUTANT */',
    why: 'The mid-day leg is sized from a 50% pool nothing holds.',
  },
  {
    id: 'S-xxii. ★★★ advisory mode would arm',
    file: MS,
    find: "  if (mode === 'advisory') return { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' };",
    to: '  /* MUTANT */',
    why: 'The shadow reports a write the configured mode never makes.',
  },
  /* ── what the mid-day figures are (fix round 1) ── */
  {
    id: 'B-i. ★★★ the mid-day figures publish no attributes',
    file: MQ,
    find: '    ...(s.json_attributes_template != null ? { json_attributes_topic: STATE_TOPIC } : {}),',
    to: '    /* MUTANT */',
    why: 'The basis attribute is templated but never read: the HA surface carries no shadow mark.',
  },
  {
    id: 'B-ii. ★★★ the mid-day figures say they are live',
    file: MS,
    find: "export const MIDDAY_CHARGE_BASIS: MiddayChargeBasis = 'shadow';",
    to: "export const MIDDAY_CHARGE_BASIS: MiddayChargeBasis = 'live'; /* MUTANT */",
    why: 'A preview is presented to dashboards and automations as a charge that runs.',
  },
  {
    id: 'B-iii. ★★ one mid-day figure loses its basis',
    file: MQ,
    find: "value_template: '{{ \"unknown\" if value_json.midday_charge_refresh is none else value_json.midday_charge_refresh }}', json_attributes_template: MIDDAY_CHARGE_ATTRIBUTES_TEMPLATE },",
    to: "value_template: '{{ \"unknown\" if value_json.midday_charge_refresh is none else value_json.midday_charge_refresh }}' }, /* MUTANT */",
    why: 'The refresh entity reads "lowered" with nothing to say it is a preview.',
  },
  {
    id: 'B-iv. ★★ the backup leg\'s "would arm" line does not say "Shadow only"',
    file: MS,
    find: " troughs at ${pct(b.cushionTroughSocPct)} against the ${pct(b.cushionLineSocPct)} line. Shadow only: nothing is armed, written or announced for it.`);",
    to: " troughs at ${pct(b.cushionTroughSocPct)} against the ${pct(b.cushionLineSocPct)} line.`); /* MUTANT */",
    why: 'A log search for "Shadow only" misses the backup\'s "would arm".',
  },
  {
    id: 'B-v. ★★ the card shows a not-comparable refresh as figures',
    file: WEBTXT,
    find: "      : r.disposition === 'not-comparable' ? 'not comparable'",
    to: "      : (false as boolean) ? 'not comparable' /* MUTANT */",
    why: 'The card reads "not-comparable, ~—" as if the refresh had sized nothing.',
  },

  /* ── review lows: a null reads unknown, with no HA warning (a; v1.190.1: the bounds are timestamp
        sensors again, their null the "None" payload every sensor type reads as unknown); the set-aside PV (f) ── */
  {
    id: 'U-i. ★★★ the window start renders a null as "unknown"',
    file: MQ,
    find: `'{{ "None" if value_json.midday_charge_window_start_at is none else value_json.midday_charge_window_start_at }}'`,
    to: `'{{ "unknown" if value_json.midday_charge_window_start_at is none else value_json.midday_charge_window_start_at }}' /* MUTANT */`,
    why: 'A timestamp sensor cannot parse "unknown": HA logs a warning carrying the whole state payload every 30 s on every weekend, weekday afternoon and summer day.',
  },
  {
    id: 'U-ii. ★★★ the window end is a text sensor again',
    file: MQ,
    find: "  { unique_id: 'ecoflow_midday_charge_window_end_at', name: 'Midday-Charge Window End', device_class: 'timestamp', icon: 'mdi:clock-end',",
    to: "  { unique_id: 'ecoflow_midday_charge_window_end_at', name: 'Midday-Charge Window End', /* MUTANT */ icon: 'mdi:clock-end',",
    why: 'HA shows the raw ISO 8601 string in place of a time (the v1.189.0 regression).',
  },
  {
    id: 'U-iii. ★★ the refresh renders a null as "None"',
    file: MQ,
    find: `'{{ "unknown" if value_json.midday_charge_refresh is none else value_json.midday_charge_refresh }}'`,
    to: `'{{ value_json.midday_charge_refresh }}' /* MUTANT */`,
    why: 'The guide says unknown; HA shows "None".',
  },
  {
    id: 'U-iv. ★★ the role renders a null as "None"',
    file: MQ,
    find: `'{{ "unknown" if value_json.night_charge_role is none else value_json.night_charge_role }}'`,
    to: `'{{ value_json.night_charge_role }}' /* MUTANT */`,
    why: 'On every night with no current plan the role reads "None".',
  },
  {
    id: 'L-xxxi. ★★★ the shadow\'s PV is kept on a set-aside row',
    file: NLS,
    find: '  if (i.pvSetAside != null) pvKwh = null;',
    to: '  /* MUTANT */',
    why: 'A three-Core window sum is graded against a one-Core P50 as forecast-skill evidence.',
  },
  {
    id: 'L-xxxii. ★★★ the scorer never passes the set-aside',
    file: IDX,
    find: '    pvSetAside: cols.pvSetAside,\n',
    to: '    pvSetAside: null, /* MUTANT */\n',
    why: 'The rule is wired in the pure core and never reached in production.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-midday-ledger', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
