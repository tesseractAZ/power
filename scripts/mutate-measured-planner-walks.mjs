#!/usr/bin/env node
/**
 * mutate-measured-planner-walks.mjs — committed harness for v1.202.0, the night-charge plan's walks on the packs' measured
 * capacity, with the Cores' standby (nightChargeAdvisor.ts plannerPoolKwh, walkStandbyW; the cost room at v1.201.0's
 * percent; the cost-carried drawback disclosure).
 *
 * (P) THE SEAM: one planning pool, read once after the refusals, on every plausible basis; absent, no reading or unit ⇒
 * the panel's figure and v1.201.0's line, and with no standby figure v1.201.0's plan, but for a line night the cost
 * force-charge carries whose walk past its stop closes under the line (it names that close; nothing written moves).
 * (L) THE LINE: plain reserve + cushion on the pool, the same percent.
 * (W) THE WALKS: none left on the panel's figure. W-i, W-iii, W-v and W-vi..ix (the window walk's clamp, the full-pack
 * proxy, the window walk's start, the whole-house trough) are the walks the line's readers in kWh compare with it: the
 * hold test, meetability, the requirement's bisection, cushionShortfall and the backup leg's setpoint walk, whose own
 * mutants (mutate-measured-cushion-line.mjs A-i..iv, A-ix) are equivalent under v1.202.0 and retired; that harness's
 * header names each reader's guards. (C) THE COST ROOM: the morning surplus × pool ÷ panel, the over-buy
 * flag's too, the de-bias bound on the panel's figure. (J) THE MIRROR: the tick's pool is the panel's figure.
 * (SB) THE WALK STANDBY: B's one figure, 0 W with none, on every discharge leg and nowhere else; (H) B's hiLift rule
 * extended to it. (S) THE SHADOW on the plan's pool and standby. (D) THE CONTRACT. (R) THE LEDGER. (F2) the minimum-buy
 * hold's bound. (X) THE DRAWBACK a cost-carried line night walks past its stop, and its disclosure: the close named
 * whatever the sizing, the card's outage-line row included.
 *
 *   node scripts/mutate-measured-planner-walks.mjs [--only <id prefix>]
 *
 * ★ Every id starts MPW- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const MS = resolve(REPO, 'server/src/middayShadow.ts');
const NFC = resolve(REPO, 'server/src/nightForceCharge.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const T_MPW = 'test/measuredPlannerWalks.test.ts';
const T_SCOPE = 'test/runwayBasisContracts.test.ts';
const T_YEAR = 'test/lineForceChargeYear.test.ts';
const T_LFC = 'test/lineForceCharge.test.ts';
const T_LINE = 'test/measuredCushionLine.test.ts';

const SEAM = '  const pool = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale);';
const POOL_RET = '  return { kwh: panelKwh * scale, lineScale: null, applied: { scale, basis: poolScale.basis } };';
const ROOM = '  const costRoomKwh: number | null = costHeadroomKwh == null ? costHeadroomKwh : costHeadroomKwh * costRoomScale;';
const DRAW_IF = "    if (mode?.kind === 'cost') {";
const CLOSE_UNDER = '    && !lineWalkHolds(lineCloseAfterStopPct ?? expected.levelPct, cushionLineSocPct);';

const MUTANTS = [
  /* ── P: the seam ── */
  {
    id: 'MPW-P-i. ★★★ the seam dropped (the walks on nameplate, the line plain on it: v1.199.0\'s defect)',
    file: NCA, tests: [T_MPW],
    find: SEAM,
    to: '  const pool = plannerPoolKwh(panelFullKwh, null); /* MUTANT */',
    why: 'The written line holds ~0.944 of the cushion again, and every walk counts too few points per kWh.',
  },
  {
    id: 'MPW-P-ii. ★★★ the scale applied twice',
    file: NCA, tests: [T_MPW],
    find: '  const fullKwh = pool.kwh;',
    to: '  const fullKwh = pool.kwh * (pool.applied?.scale ?? 1); /* MUTANT */',
    why: 'A pool of N · s²: every drain a point too deep per 17 kWh, the reference requirement off by kWh.',
  },
  {
    id: 'MPW-P-iii. ★★ the plan\'s key on the islanded-outage basis only',
    file: NCA, tests: [T_MPW],
    find: '  const planScale = pool.applied ?? cushionLine.applied;',
    to: "  const planScale = cushionBasis === 'islanded-outage' ? (pool.applied ?? cushionLine.applied) : cushionLine.applied; /* MUTANT */",
    why: 'A legacy-pct row\'s walks are on the measured pool and its row cannot say so.',
  },
  {
    id: 'MPW-P-iv. ★★★ a scale under 0.5 is a pool',
    file: NCA, tests: [T_MPW],
    find: '  const s = poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) {',
    to: '  const s = poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s <= 0 || s > 1 + 1e-9) { /* MUTANT */',
    why: 'A 0.3 reading plans a pool of 27.6 kWh: every walk drains it in hours.',
  },
  {
    id: 'MPW-P-v. ★★★ NaN is a pool',
    file: NCA, tests: [T_MPW],
    find: '  const s = poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) {',
    to: '  const s = poolScale.scale;\n  if (typeof s !== \'number\' || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) { /* MUTANT */',
    why: 'A NaN pool: every comparison false, the v1.39.0 fail-open class.',
  },
  {
    id: 'MPW-P-vi. ★★ a unit scale is recorded as a pool on every basis',
    file: NCA, tests: [T_MPW],
    find: '  if (scale === 1) return { kwh: panelKwh, lineScale: poolScale, applied: null };',
    to: '  /* MUTANT */',
    why: 'A plan that moved no number gains a key on the legacy band: v1.201.0\'s plan is no longer reproduced at scale 1.',
  },
  {
    id: 'MPW-P-vii. ★★★ an absent scale reads as the reference fleet\'s 0.944',
    file: NCA, tests: [T_MPW],
    find: '  if (poolScale == null) return { kwh: panelKwh, lineScale: poolScale, applied: null };',
    to: '  if (poolScale == null) return { kwh: panelKwh * 0.944, lineScale: null, applied: null }; /* MUTANT */',
    why: 'Every caller before v1.202.0, and a tracker that threw, plans a pool nothing measured.',
  },
  {
    id: 'MPW-P-viii. ★ the seam above the capacity gate (behaviourally equivalent: the gate refuses a bad panel figure either way)',
    file: NCA, tests: [T_SCOPE],
    find: "  if (!Number.isFinite(panelFullKwh) || panelFullKwh <= 0) return refuse('pool capacity unavailable', true);",
    to: "  const poolEarly = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale); void poolEarly; /* MUTANT */\n  if (!Number.isFinite(panelFullKwh) || panelFullKwh <= 0) return refuse('pool capacity unavailable', true);",
    why: 'A second read of the scale, above the refusals: the contract counts one, after the last refusal.',
  },

  /* ── L: the line ── */
  {
    id: 'MPW-L-i. ★★★ the line keeps ÷ s on the measured pool (the scale twice in the line)',
    file: NCA, tests: [T_MPW],
    find: POOL_RET,
    to: '  return { kwh: panelKwh * scale, lineScale: poolScale, applied: { scale, basis: poolScale.basis } }; /* MUTANT */',
    why: 'The 33.26% line becomes 34.29%: every resilience night writes a point high for a cushion it already holds.',
  },
  {
    id: 'MPW-L-ii. ★★★ the reserve on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '  const reserveKwh = (fullKwh * reserveFloorPct) / 100;',
    to: '  const reserveKwh = (panelFullKwh * reserveFloorPct) / 100; /* MUTANT */',
    why: 'The floor is the panel\'s own percent of the measured pool: on N it holds 0.95 kWh more per 16 points than there is.',
  },

  /* ── W: no walk left on the panel figure ── */
  {
    id: 'MPW-W-i. ★★★ the islanded carry to the close on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '  const baseline = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd, holdLift);',
    to: '  const baseline = simulate(socNowKwh, panelFullKwh, preHorizon, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd, holdLift); /* MUTANT */',
    why: 'The no-buy pack is clamped to a pool the packs do not have: a near-full night holds a line it cannot.',
  },
  {
    id: 'MPW-W-ii. ★★ the pre-window dip stated on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '    preWindowMinSocPct = round1((preWindow.minPackKwh / fullKwh) * 100);',
    to: '    preWindowMinSocPct = round1((preWindow.minPackKwh / panelFullKwh) * 100); /* MUTANT */',
    why: 'The dip reads 1/0.944 too shallow: 14.6% stated as 13.8%.',
  },
  {
    id: 'MPW-W-iii. ★★★ the pack now on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '  const socNowKwh = (fullKwh * socNowPct) / 100;',
    to: '  const socNowKwh = (panelFullKwh * socNowPct) / 100; /* MUTANT */',
    why: 'The pool starts 5.6% fuller than it is: the requirement and the buy fall.',
  },
  {
    id: 'MPW-W-iv. ★★★ the expected buy on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '      startKwh: expectedStartKwh, deliverableKwh: expectedDeliverableKwh, fullKwh, legEff,',
    to: '      startKwh: expectedStartKwh, deliverableKwh: expectedDeliverableKwh, fullKwh: panelFullKwh, legEff, /* MUTANT */',
    why: 'The expected draw to 80% counts nameplate kWh per point: 34.1 kWh stated as more.',
  },
  {
    id: 'MPW-W-v. ★★ the setpoint walk clamped on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '    simulate(p, fullKwh, postHours, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd).minPackKwh;',
    to: '    simulate(p, panelFullKwh, postHours, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd).minPackKwh; /* MUTANT */',
    why: 'The legacy band and the backup leg ask for a pack the measured pool cannot hold.',
  },
  {
    id: 'MPW-W-vi. ★★★ the window walk clamped on the panel figure (meetability\'s, the requirement\'s and cushionShortfall\'s pack)',
    file: NCA, tests: [T_MPW, T_LINE],
    find: '      pack = Math.max(0, Math.min(fullKwh, pack + gainKwh + chargeLegStep(pvKwh - drainKwh, legEff)));',
    to: '      pack = Math.max(0, Math.min(panelFullKwh, pack + gainKwh + chargeLegStep(pvKwh - drainKwh, legEff))); /* MUTANT */',
    why: 'A lift the measured pool cannot take reads as pack: 105.9% arrives (2026-10-28 21:30, 4 h; the backup leg\'s full-effort night 102.6%), and the readers compare it with the line.',
  },
  {
    id: 'MPW-W-vii. ★★★ the full-pack proxy on the panel figure (the requirement meetability hands an unmeetable line)',
    file: NCA, tests: [T_MPW, T_LINE],
    find: '  const poolHeadroomLiftKwh = Math.max(0, fullKwh - packAtWindowEnd_noBuy);',
    to: '  const poolHeadroomLiftKwh = Math.max(0, panelFullKwh - packAtWindowEnd_noBuy); /* MUTANT */',
    why: 'The charge-bound night that cannot meet its line asks 92.16 kWh of an 87 kWh pool: the proxy is 5.6% more than the packs hold.',
  },
  {
    id: 'MPW-W-viii. ★★ the window walk starts from a carry on the panel figure',
    file: NCA, tests: [T_MPW],
    find: '  const packAtWindowStartKwh = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, legEff, walkStandbyW, windowStart, windowStart, holdLift).packAtMarkKwh;',
    to: '  const packAtWindowStartKwh = simulate(socNowKwh, panelFullKwh, preHorizon, dischargeEff, legEff, walkStandbyW, windowStart, windowStart, holdLift).packAtMarkKwh; /* MUTANT */',
    why: 'The pack the lift is added to keeps sun the packs cannot take: a 13:00 plan\'s requirement falls (2027-03-12: 10.96 for 11.2 kWh) and an 86th minimum-buy hold appears.',
  },
  {
    id: 'MPW-W-ix. ★★ the whole-house trough on the panel figure (the legacy band\'s and the backup leg\'s cushion trough)',
    file: NCA, tests: [T_MPW, T_LINE],
    find: '    const r = simulate(packAtWindowEndWith(lift), fullKwh, postHours, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd);',
    to: '    const r = simulate(packAtWindowEndWith(lift), panelFullKwh, postHours, dischargeEff, legEff, walkStandbyW, windowEnd, windowEnd); /* MUTANT */',
    why: 'The trough the hold test and the requirement compare with the line reads high: 29.8% for 29.29% (2027-05-10 21:30, 4 h).',
  },

  /* ── C: the cost room at v1.201.0's percent ── */
  {
    id: 'MPW-C-i. ★★★ the cost room on the measured pool (the critique\'s defect 1: the sun\'s share asserted)',
    file: NCA, tests: [T_MPW],
    find: ROOM,
    to: '  const costRoomKwh: number | null = costHeadroomKwh; /* MUTANT */',
    why: 'Every pv-headroom ceiling falls about a point (80.4 → 79.2%), on a share of the sun the walks\' standby leaves unestablished.',
  },
  {
    id: 'MPW-C-ii. ★★ the over-buy flag on the measured pool',
    file: NCA, tests: [T_MPW],
    find: '    targetPackKwh > fullKwh - morningPvSurplusP90Kwh * costRoomScale + 1e-6',
    to: '    targetPackKwh > fullKwh - morningPvSurplusP90Kwh + 1e-6 /* MUTANT */',
    why: 'Resilience nights flag an accepted clip v1.201.0 did not: the binding cap moves on the sun\'s unestablished share.',
  },
  {
    id: 'MPW-C-iii. ★★★ the de-bias bound on the pool (the critique\'s emulation)',
    file: NCA, tests: [T_MPW],
    find: '    fullKwh: panelFullKwh,\n    // The pack the resilience buy lifts to; with no resilience buy there is nothing for the\n    // force-charge to deliver, so no bound (a hold night reports its de-biased ceiling).\n    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh / costRoomScale : 0,',
    to: '    fullKwh,\n    // The pack the resilience buy lifts to; with no resilience buy there is nothing for the\n    // force-charge to deliver, so no bound (a hold night reports its de-biased ceiling).\n    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh : 0, /* MUTANT */',
    why: 'The bound is 5.6 + 0.944 × the target\'s percent, not the target\'s percent: the ceilings and writes the year pins move.',
  },
  {
    id: 'MPW-C-iv. ★★★ the de-bias bound\'s target left in pool kWh',
    file: NCA, tests: [T_MPW],
    find: '    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh / costRoomScale : 0,',
    to: '    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh : 0, /* MUTANT */',
    why: 'The bound allows a ceiling 0.944 × the resilience target: a de-biased stop under the percent the resilience buy reaches.',
  },

  /* ── J: the tick's mirror ── */
  {
    id: 'MPW-J-i. ★★★ the tick\'s mirror on the planning pool',
    file: NCA, tests: [T_MPW, T_SCOPE],
    find: 'noReOn: lineNoReOn != null, runOn: lineRunOn, tickPoolKwh: panelFullKwh,',
    to: 'noReOn: lineNoReOn != null, runOn: lineRunOn, tickPoolKwh: fullKwh, /* MUTANT */',
    why: 'The stated start is a minute the tick (backupFullCapWh, nameplate) never comes due at: up to hours late.',
  },
  {
    id: 'MPW-J-ii. ★★★ the just-in-time walk times its start on its own pool',
    file: NCA, tests: [T_MPW],
    find: '      if (t >= forceChargeStartAtMs(o.windowEndMs, o.ceilingPct, poolPct, o.tickPoolKwh, rateKw, evDisplacedKwh)) {',
    to: '      if (t >= forceChargeStartAtMs(o.windowEndMs, o.ceilingPct, poolPct, o.fullKwh, rateKw, evDisplacedKwh)) { /* MUTANT */',
    why: 'The mirror bypassed one call down: the walk times the tick on the measured pool.',
  },

  /* ── SB: the walk standby ── */
  {
    id: 'MPW-SB-i. ★★★ the standby drained while the grid charges (the with-buy window walk)',
    file: NCA, tests: [T_MPW],
    find: '      const drainKwh = ((h.loadP90W / 1000) * (1 - chargeFrac)) / dischargeEff + (walkStandbyW / 1000) * (1 - chargeFrac);',
    to: '      const drainKwh = ((h.loadP90W / 1000) * (1 - chargeFrac)) / dischargeEff + walkStandbyW / 1000; /* MUTANT */',
    why: 'While the charger runs the grid feeds the Cores: draining the standby then over-sizes the reference requirement.',
  },
  {
    id: 'MPW-SB-ii. ★★★ the standby\'s sign flipped (a credit)',
    file: NCA, tests: [T_MPW],
    find: '    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W - h.loadP90W / dischargeEff - standbyW, chargeEff)));',
    to: '    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W - h.loadP90W / dischargeEff + standbyW, chargeEff))); /* MUTANT */',
    why: 'The Cores\' draw becomes energy: the requirement and the worst case fall with the figure.',
  },
  {
    id: 'MPW-SB-iii. ★★★ no figure reads as 270 W',
    file: NCA, tests: [T_MPW],
    find: '  const walkStandbyW = standbyW?.w ?? 0;',
    to: '  const walkStandbyW = standbyW?.w ?? 270; /* MUTANT */',
    why: 'Every caller with no figure drains the runway\'s default: v1.201.0\'s plan is not reproduced with none.',
  },
  {
    id: 'MPW-SB-iv. ★★★ the standby counted twice in the cushion (B\'s term and the walks\')',
    file: NCA, tests: [T_MPW],
    find: "  const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + standby.kwh) : cushion.kwh;",
    to: "  const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + 2 * standby.kwh) : cushion.kwh; /* MUTANT */",
    why: 'The walks end at the close, where the cushion begins: the cushion holds its own hours\' standby once.',
  },
  {
    id: 'MPW-SB-v. ★★ the standby taken from the window\'s charge gain',
    file: NCA, tests: [T_MPW],
    find: '      const gainKwh = hourLiftKwh * chargeFrac;',
    to: '      const gainKwh = hourLiftKwh * chargeFrac - (walkStandbyW / 1000) * chargeFrac; /* MUTANT */',
    why: 'The grid feeds the Cores while it charges them: a gain cut by the standby over-sizes the buy.',
  },
  {
    id: 'MPW-SB-vi. ★★★ the expected carry drains no standby',
    file: NCA, tests: [T_MPW],
    find: '      ...(holdLift != null ? { hold: { kwh: holdLift.minKwh, untilMs: holdLift.atMs } } : {}),\n      standbyW: walkStandbyW,\n',
    to: '      ...(holdLift != null ? { hold: { kwh: holdLift.minKwh, untilMs: holdLift.atMs } } : {}),\n      standbyW: 0, /* MUTANT */\n',
    why: 'The pool expected at the open reads 1.2 points high on the reference night (43.7% stated 44.9%).',
  },
  {
    id: 'MPW-SB-vii. ★★★ a second read of the figure (the input, not B\'s validated one)',
    file: NCA, tests: [T_MPW, T_SCOPE],
    find: '  const walkStandbyW = standbyW?.w ?? 0;',
    to: '  const walkStandbyW = typeof inputs.cushionStandbyW === \'number\' ? inputs.cushionStandbyW : 0; /* MUTANT */',
    why: 'A figure that is no reading (−1, 2000 W) reaches the walks: the one read, bypassed.',
  },
  {
    id: 'MPW-SB-viii. ★★ the expected walks drain no standby',
    file: NCA, tests: [T_MPW],
    find: '      window: { hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, dischargeEff, chargeCapKw, envelopeKw, acceptKw, standbyW: walkStandbyW },',
    to: '      window: { hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, dischargeEff, chargeCapKw, envelopeKw, acceptKw }, /* MUTANT */',
    why: 'The drain to a just-in-time start and the line walk\'s latched drain leave the Cores out: one plan, two plants.',
  },

  /* ── H: B's hiLift rule extended ── */
  {
    id: 'MPW-H-i. ★★★ the hiLift rule not extended to the walks\' standby',
    file: NCA, tests: [T_MPW],
    find: '    requiredExtraKwh = standbyCounted || walkStandbyW > 0 ? hiLift : poolHeadroomLiftKwh;',
    to: '    requiredExtraKwh = standbyCounted ? hiLift : poolHeadroomLiftKwh; /* MUTANT */',
    why: 'Off islanded-outage the legacy proxy returns: a standby that makes a night unmeetable lowers its requirement and worst case.',
  },

  /* ── S: the shadow ── */
  {
    id: 'MPW-S-i. ★★ the shadow\'s held import on the panel figure',
    file: IDX, tests: [T_MPW, T_SCOPE],
    find: 'floorPct: plan.reserveFloorPct, fullKwh: plan.planPool?.kwh ?? fullKwh, standbyW: plan.planPool?.standbyW ?? 0, dischargeEff, legEff,',
    to: 'floorPct: plan.reserveFloorPct, fullKwh, standbyW: plan.planPool?.standbyW ?? 0, dischargeEff, legEff, /* MUTANT */',
    why: 'The shadow walks a pool the plan it shadows did not.',
  },
  {
    id: 'MPW-S-ii. ★★ the shadow drains no standby',
    file: MS, tests: [T_MPW],
    find: '    const net = chargeLegStep((w * (Math.max(0, h.pvP50W) - Math.max(0, h.loadP50W) / o.dischargeEff - standbyW)) / 1000, o.legEff);',
    to: '    const net = chargeLegStep((w * (Math.max(0, h.pvP50W) - Math.max(0, h.loadP50W) / o.dischargeEff)) / 1000, o.legEff); /* MUTANT */',
    why: 'The held-import estimate leaves out the Cores the plan\'s walks drain.',
  },

  /* ── D: the contract ── */
  {
    id: 'MPW-D-i. ★★★ a second read of the scale in the sizing',
    file: NCA, tests: [T_SCOPE],
    find: '  const planScale = pool.applied ?? cushionLine.applied;',
    to: '  const planScale = pool.applied ?? cushionLine.applied ?? (inputs.cushionPoolScale != null ? cushionLine.applied : null); /* MUTANT */',
    why: 'The scale read twice: the seam is the one place.',
  },
  {
    id: 'MPW-D-ii. ★★★ index.ts counts a pool of its own (deps.fullKwh × the scale)',
    file: IDX, tests: [T_SCOPE],
    find: '    fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,',
    to: '    fullKwh: fullKwh * (cushionPoolScale?.scale ?? 1), socNowPct, reserveFloorPct, cushionPct, socCoherent, /* MUTANT */',
    why: 'The scale applied twice through the door: once in index.ts, once at the seam.',
  },
  {
    id: 'MPW-D-iii. ★★ the tick module names the planning pool',
    file: NFC, tests: [T_SCOPE],
    find: '  return limits.forceChargeKwPerCore ?? FORCE_CHARGE_PROVEN_KW_PER_SLOT;',
    to: "  return (limits.forceChargeKwPerCore ?? FORCE_CHARGE_PROVEN_KW_PER_SLOT) + 0 * 'plannerPoolKwh'.length; /* MUTANT */",
    why: 'The force-charge tick reads backupFullCapWh only: its mirror is the planner\'s to keep.',
  },

  /* ── R: the ledger ── */
  {
    id: 'MPW-R-i. ★★★ the pool written only where the plan carries one',
    file: IDX, tests: [T_MPW],
    find: '    ...planPoolLedgerColumns(plan, extras.fullKwh),',
    to: '    ...(plan.planPool ? planPoolLedgerColumns(plan, extras.fullKwh) : {}), /* MUTANT */',
    why: 'A re-issued plan on the panel\'s figure keeps the earlier plan\'s pool beside its own percents.',
  },
  {
    id: 'MPW-R-ii. ★★★ the columns are not in the ledger allowlist',
    file: REC, tests: [T_MPW],
    find: "  'plan_pool_kwh', 'plan_walk_standby_w',\n",
    to: '  /* MUTANT */\n',
    why: 'The write is dropped silently: no row says which pool its percents are of.',
  },
  {
    id: 'MPW-R-iii. ★★★ the columns are never added to a deployed ledger',
    file: REC, tests: [T_MPW],
    find: "    'plan_pool_kwh REAL', 'plan_walk_standby_w REAL',",
    to: '    /* MUTANT */',
    why: 'Every plan write fails on the deployed database.',
  },
  {
    id: 'MPW-R-iv. ★★ a sized row with no planPool records NULL (the panel\'s figure unsaid)',
    file: NCA, tests: [T_MPW],
    find: '    plan_pool_kwh: plan.planPool?.kwh ?? Math.round(panelFullKwh * 1000) / 1000,',
    to: '    plan_pool_kwh: plan.planPool?.kwh ?? null, /* MUTANT */',
    why: 'A sized row on the panel\'s figure reads like a refused one: the critique\'s ledger finding.',
  },
  {
    id: 'MPW-R-v. ★★ the walks\' standby unrecorded off the islanded basis',
    file: NCA, tests: [T_MPW],
    find: '    plan_walk_standby_w: plan.planPool?.standbyW ?? 0,',
    to: '    plan_walk_standby_w: plan.planPool?.standbyW ?? null, /* MUTANT */',
    why: 'A legacy-pct row\'s setpoint steps with the standby and nothing on the row explains it.',
  },
  {
    id: 'MPW-R-vi. ★★ the hold plan carries no pool',
    file: NCA, tests: [T_MPW],
    find: "      // v1.202.0 — the pool and the standby the walks counted, only where either differs from v1.201.0's walks.\n      ...planPoolField,\n      // v1.201.0",
    to: "      // v1.202.0 — the pool and the standby the walks counted, only where either differs from v1.201.0's walks.\n      /* MUTANT */\n      // v1.201.0",
    why: 'A hold row\'s percents are of the measured pool and its row says the panel\'s.',
  },

  /* ── F2: the minimum-buy hold's bound ── */
  {
    id: 'MPW-F2-i. ★★★ the minimum buy tripled (a hold whose need the bound does not cover)',
    file: NCA, tests: [T_MPW],
    find: '  const chargeTonight = buyKwh >= minBuyKwh;',
    to: '  const chargeTonight = buyKwh >= minBuyKwh * 3; /* MUTANT */',
    why: 'A resilience night holds up to 3 · minBuy · legEff under its line, and its text says the need is genuinely small.',
  },

  /* ── X: the cost-carried drawback ── */
  {
    id: 'MPW-X-i. ★★★ the walk past the stop dropped (v1.201.0\'s claim)',
    file: NCA, tests: [T_MPW],
    find: DRAW_IF,
    to: '    if ((false as boolean) && mode?.kind === \'cost\') { /* MUTANT */',
    why: '23 line nights of the year close under their line after the cost stop, and claim it.',
  },
  {
    id: 'MPW-X-ii. ★★★ the walk past the stop books a re-ON (cost mode has none)',
    file: NCA, tests: [T_MPW],
    find: '        acceptKw: o.window.acceptKw ?? null, noReOn: true, runOn: jit.startMs != null, standbyW: o.window.standbyW,',
    to: '        acceptKw: o.window.acceptKw ?? null, noReOn: false, runOn: jit.startMs != null, standbyW: o.window.standbyW, /* MUTANT */',
    why: 'The walk refills a pool the tick never switches on again: nights under the line read as held.',
  },
  {
    id: 'MPW-X-iii. ★★★ a cost-carried night judged on its stop, not its close',
    file: NCA, tests: [T_MPW],
    find: CLOSE_UNDER,
    to: '    && !lineWalkHolds(expected.levelPct, cushionLineSocPct); /* MUTANT */',
    why: 'The stop is ⌈L⌉ + 10 or more: no cost-carried night is ever disclosed.',
  },
  {
    id: 'MPW-X-iv. ★★★ lineNotHeldOf ignores the close past the stop',
    file: NCA, tests: [T_MPW, T_YEAR],
    find: '    return c != null && Number.isFinite(c) && !lineWalkHolds(c, l) ? \'closeUnder\' : null;',
    to: '    return null; /* MUTANT */',
    why: 'The plan discloses and no surface words it: the push, the card and the 21:30 line say nothing.',
  },
  {
    id: 'MPW-X-v. ★★★ the NOTE names the stop as the close',
    file: NCA, tests: [T_MPW],
    find: '    ? ` NOTE: on the median load the pool is expected to close at ~${closeAfterStopField.expectedCloseAfterStopPct ?? expected.levelPct}%, under tonight\'s ${cushionLineSocPct}% outage line, so the cushion is not fully held — residual risk remains.`',
    to: '    ? ` NOTE: on the median load the pool is expected to close at ~${expected.levelPct}%, under tonight\'s ${cushionLineSocPct}% outage line, so the cushion is not fully held — residual risk remains.` /* MUTANT */',
    why: '"close at ~70%, under the 52.7% line": a false sentence.',
  },
  {
    id: 'MPW-X-vi. ★★ the card\'s mirror ignores the close past the stop',
    file: CARD, tests: [T_YEAR],
    find: '    return c != null && Number.isFinite(c) && c < l - 0.05 - 1e-9 ? \'closeUnder\' : null;',
    to: '    return null; /* MUTANT */',
    why: 'The card disagrees with the server on every disclosed cost-carried night.',
  },
  {
    id: 'MPW-X-vii. ★★★ the close past the stop named only where the sizing held the line (the gate before the fix)',
    file: NCA, tests: [T_MPW],
    find: '  const closeAfterStopField = lineArmed && lineCloseAfterStopPct != null && !lineWalkHolds(lineCloseAfterStopPct, cushionLineSocPct)',
    to: '  const closeAfterStopField = lineCloseUnder && lineCloseAfterStopPct != null /* MUTANT */',
    why: 'A cost-carried night sized short closes up to ~22 points under its line with only the caps note: no surface names the close (70 nights on nameplate, 57 at ×0.944).',
  },
  {
    id: 'MPW-X-viii. ★★★ the card\'s outage-line row names no close on a cost-carried night',
    file: CARD, tests: [T_MPW, T_LFC],
    find: '    if (kind === \'closeUnder\' && c != null && Number.isFinite(c)) {',
    to: '    if ((false as boolean) && kind === \'closeUnder\' && c != null && Number.isFinite(c)) { /* MUTANT */',
    why: 'The card says only that the line is not claimed; its one percent is the ~70% stop, read as the close above the line.',
  },
  {
    id: 'MPW-X-ix. ★★ the card\'s row keyed on the envelope cause alone',
    file: CARD, tests: [T_MPW, T_LFC],
    find: '  if (row == null && armed && (plan.cushionShortfallCause != null || kind === \'closeUnder\')) {',
    to: '  if (row == null && armed && plan.cushionShortfallCause != null) { /* MUTANT */',
    why: 'A cost-carried night sized short (no envelope cause) shows no outage-line row though its close is under the line.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-measured-planner-walks', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
