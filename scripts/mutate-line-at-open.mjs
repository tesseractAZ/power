#!/usr/bin/env node
/**
 * mutate-line-at-open.mjs — committed harness for v1.205.0, the line night's claim (nightChargeAdvisor.ts expectedBuyFromPlan,
 * expectedLineBuy, lineWindowReachKwh).
 *
 * (C) H1 ON THE COST-CARRIED WALK: a line night the cost force-charge carries closes where its walk past the stop ends, never
 * above what the window can reach (the one reach expression a bound line walk's close is capped at); the stated close floored at
 * the reserve, the claim's close (rawClosePct) not. AOA-7, AOA-7b.
 * (A) THE AT-OPEN ALLOWANCE (nightForceCharge.ts FORCE_CHARGE_OPEN_ALLOWANCE_MS, armedLineRunOnSinceMs; nightChargeAdvisor.ts
 * expectedLineForceChargeWalk onNotBeforeMs, expectedBuyFromPlan assureUntilMs, withAssuredClose, the plan's claim; index.ts; the
 * texts): a line night is carried only where its walk holds the line on the median and with nothing charging before each whole
 * ON minute up to the window open + 20 min, its reach counted from that minute, the lowest close of them; else 'lateStart',
 * still armed. Anchored at the window open; a verified ON in the pool reading ends it. AOA-1..AOA-23 (with b/c variants).
 * (W) THE WORDS BY ONE PREDICATE (review): a 'lateStart' night names a late switch-on at the window open only where the plan's own
 * start is inside the allowance (NightChargePlan.cushionLateStartAtOpen, nightForceCharge.lateStartAllowanceWords), else a late
 * start of the window's charge — on the rationale, the push, the card, both ARMED lines and the mid-day push. AOA-24 (a..k).
 * (R) ROUND 2 (review): a cost-carried 'lateStart' night carries its close past the stop (expectedCloseAfterStopPct) and the 21:30
 * push and the ARMED line name it as the rationale does, never the stop (AOA-15b/c, AOA-17d, AOA-25/25b); the sweep's grid and its
 * start (AOA-19b/c); the deferral's anchor (AOA-22b); the H1 cap the walk identity's guard reads (AOA-26).
 * (F) ROUND 3 (review): a refused arm arms nothing, so the 21:30 and mid-day pushes say once that nothing is armed to carry a line
 * night's line, never an armed night's note (notify.ts refusedEnvelopeNote, chargeText.ts armedNote). AOA-27 (a..e).
 *
 *   node scripts/mutate-line-at-open.mjs [--only <id prefix>]
 *
 * ★ Every id starts AOA- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const NFC = resolve(REPO, 'server/src/nightForceCharge.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const CTX = resolve(REPO, 'server/src/chargeText.ts');
const MSH = resolve(REPO, 'server/src/middayShadow.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const T_AO = 'test/lineAtOpenAllowance.test.ts';
const T_REPLAY = 'test/lineAtOpenReplay.test.ts';
const T_MPW = 'test/measuredPlannerWalks.test.ts';
const T_YEAR = 'test/lineForceChargeYear.test.ts';
const T_LINE = 'test/lineForceCharge.test.ts';
const T_WALK = 'test/lineStandingWalk.test.ts';

const LATE = "  const lineLateStart = lineArmed && chargeTonight && !lineNearFull && !cushionShortfall && !lineCloseUnder\n    && expected.assuredClosePct !== undefined && !lineWalkHolds(expected.assuredClosePct, cushionLineSocPct);";
const VERIFIED = '  const lineOnVerifiedBy = inputs.armedLineOnVerifiedAtMs != null && Number.isFinite(inputs.armedLineOnVerifiedAtMs)\n    && inputs.armedLineOnVerifiedAtMs >= windowStart && inputs.armedLineOnVerifiedAtMs <= nowMs;';
const SWEEP = '    const close = expectedBuyFromPlan({ ...o, onNotBeforeMs: m, deliverableKwh }).rawClosePct;';
const MINUTES = '  if (startMs != null && startMs <= untilMs) for (let m = fromMs + EXPECTED_JIT_STEP_MS; m <= untilMs; m += EXPECTED_JIT_STEP_MS) minutes.push(m);';
const LINE_WALK_DEFER = "    acceptKw: o.window.acceptKw ?? null, noReOn: o.noReOn, runOn: o.runOn, standbyW: o.window.standbyW,\n    ...(o.onNotBeforeMs != null ? { onNotBeforeMs: o.onNotBeforeMs } : {}),";
const CLOSE_FIELD = '  const closeAfterStopField = lineArmed && lineCloseAfterStopPct != null && (!lineWalkHolds(lineCloseAfterStopPct, cushionLineSocPct) || lineLateStart)';
const COST_ARM = "  return eligible + (lineNotHeldOf(plan) === 'lateStart' ? lateStartArmTail(plan?.expectedCloseAfterStopPct, plan?.cushionLateStartAtOpen) : '');";

const MUTANTS = [
  /* ── C: H1 on the cost-carried walk ── */
  {
    id: 'AOA-7. ★★★ no cost-carried reach cap (the walk past the stop stated whatever the window can deliver)',
    file: NCA, tests: [T_AO, T_MPW, T_YEAR],
    find: '  if (out.deliverableBound === true && out.rawClosePct != null) {\n    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;',
    to: '  if ((false as boolean) && out.rawClosePct != null) { /* MUTANT */\n    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;',
    why: '2027-02-05 21:30 at ×0.944, 20 h: ~65.8% stated past the stop from a pool the window can take to ~59.9%.',
  },
  {
    id: 'AOA-7b. ★★ the cap on the stated close only, not on the close the claim reads',
    file: NCA, tests: [T_AO],
    find: '      out.rawClosePct = round1(Math.min(100, reachPct));\n',
    to: '      /* MUTANT */\n',
    why: 'The claim reads a close the window cannot reach: a cost-carried night out of reach is judged on its uncapped walk.',
  },

  /* ── A: the at-open allowance ── */
  {
    id: 'AOA-1. ★★★ no allowance (0 min)',
    file: NFC, tests: [T_AO, T_REPLAY],
    find: 'export const FORCE_CHARGE_OPEN_ALLOWANCE_MS = FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * FORCE_CHARGE_TICK_MS;',
    to: 'export const FORCE_CHARGE_OPEN_ALLOWANCE_MS = 0; /* MUTANT */',
    why: 'A Friday one-hour night is claimed on a walk that charges from the open, which no ON does: 7 of 168 close under on the replay.',
  },
  {
    id: 'AOA-2. ★★ the allowance three ticks (the ON\'s lead only, no re-issue)',
    file: NFC, tests: [T_AO, T_REPLAY],
    find: 'export const FORCE_CHARGE_OPEN_ALLOWANCE_MS = FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * FORCE_CHARGE_TICK_MS;',
    to: 'export const FORCE_CHARGE_OPEN_ALLOWANCE_MS = 3 * FORCE_CHARGE_TICK_MS; /* MUTANT */',
    why: 'A Core that misses the ON is re-issued only after its readback grace: two late Cores close claimed nights under.',
  },
  {
    id: 'AOA-3. ★★★ the claim never reads the assured walk (lineLateStart false)',
    file: NCA, tests: [T_AO, T_REPLAY],
    find: LATE,
    to: '  const lineLateStart = (false as boolean); /* MUTANT */',
    why: 'Every night the median walk holds is carried, whatever a late switch-on at the open does.',
  },
  {
    id: 'AOA-4. ★★★ the walk ignores onNotBeforeMs (charges from its start)',
    file: NCA, tests: [T_AO],
    find: '    const charging = startMs != null && (o.onNotBeforeMs == null || t >= o.onNotBeforeMs);',
    to: '    const charging = startMs != null; /* MUTANT */',
    why: 'The assured walk charges from the open: only the reach moves, and an unbound night (2027-08-09 13:00) is never deferred.',
  },
  {
    id: 'AOA-4b. ★★ only the rising branch deferred (the wait read as the panel\'s latch)',
    file: NCA, tests: [T_AO],
    find: '    } else if (charging) {\n      reached = true;',
    to: '    } else if (startMs != null) { /* MUTANT */\n      reached = true;',
    why: 'A deferred walk reads as latched at the ceiling: it states the panel\'s stop and re-ONs during the wait.',
  },
  {
    id: 'AOA-5. ★★★ the reach not shifted (the assured walk keeps the median\'s deliverable)',
    file: NCA, tests: [T_AO],
    find: SWEEP,
    to: '    const close = expectedBuyFromPlan({ ...o, onNotBeforeMs: m }).rawClosePct; /* MUTANT */',
    why: 'A bound night whose walk starts past the allowance (2027-02-15 on nameplate, 18 h) is judged on a reach counted from the open.',
  },
  {
    id: 'AOA-5b. ★★ the line walk not told the allowance (expectedLineBuy)',
    file: NCA, tests: [T_AO],
    find: LINE_WALK_DEFER,
    to: '    acceptKw: o.window.acceptKw ?? null, noReOn: o.noReOn, runOn: o.runOn, standbyW: o.window.standbyW, /* MUTANT */',
    why: 'A line walk deferred nowhere: only its reach moves (2027-08-09 13:00 closes ~77.8%, not ~69.1%).',
  },
  {
    id: 'AOA-5c. ★★ the cost walk past the stop not told the allowance',
    file: NCA, tests: [T_AO],
    find: "        acceptKw: o.window.acceptKw ?? null, noReOn: true, runOn: jit.startMs != null, standbyW: o.window.standbyW,\n        ...(o.onNotBeforeMs != null ? { onNotBeforeMs: o.onNotBeforeMs } : {}),",
    to: '        acceptKw: o.window.acceptKw ?? null, noReOn: true, runOn: jit.startMs != null, standbyW: o.window.standbyW, /* MUTANT */',
    why: 'A cost-carried night that is not window-bound is judged on a walk past its stop that charges from the open.',
  },
  {
    id: 'AOA-6. ★★★ the claim reads the floored (stated) close, not rawClosePct',
    file: NCA, tests: [T_AO],
    find: SWEEP,
    to: "    const r = expectedBuyFromPlan({ ...o, onNotBeforeMs: m, deliverableKwh }); const close = r.mode === 'line' ? r.levelPct : r.closePct; /* MUTANT */",
    why: '2026-11-27 21:30 at ×0.944, 16 h: a 49.99% line the median walk holds (~50.0%) and the assured walk does not (~47.5% at the allowance\'s end); floored, every minute reads 50% and the night is carried on the floor.',
  },
  {
    id: 'AOA-8. ★★★ the allowance anchored at the plan\'s own start, not the window open',
    file: NCA, tests: [T_AO],
    find: '  const lineOpenAllowanceEndMs = windowStart + FORCE_CHARGE_OPEN_ALLOWANCE_MS;',
    to: '  const lineOpenAllowanceEndMs = effChargeStartMs + FORCE_CHARGE_OPEN_ALLOWANCE_MS; /* MUTANT */',
    why: 'Every recompute takes 20 more minutes off a run that may have been on since the open: it never lapses.',
  },
  {
    id: 'AOA-9. ★★★ a verify after the pool reading accepted (<= nowMs dropped)',
    file: NCA, tests: [T_AO],
    find: VERIFIED,
    to: '  const lineOnVerifiedBy = inputs.armedLineOnVerifiedAtMs != null && Number.isFinite(inputs.armedLineOnVerifiedAtMs)\n    && inputs.armedLineOnVerifiedAtMs >= windowStart; /* MUTANT */',
    why: 'The walk credits a full-rate charge from a pool read before the ON took (a verify landing across the awaits).',
  },
  {
    id: 'AOA-10. ★★ a verify before the window open accepted (>= windowStart dropped)',
    file: NCA, tests: [T_AO],
    find: VERIFIED,
    to: '  const lineOnVerifiedBy = inputs.armedLineOnVerifiedAtMs != null && Number.isFinite(inputs.armedLineOnVerifiedAtMs)\n    && inputs.armedLineOnVerifiedAtMs <= nowMs; /* MUTANT */',
    why: 'An earlier night\'s ON ends tonight\'s allowance.',
  },
  {
    id: 'AOA-11. ★★ the verify ignored (the allowance always runs to +20)',
    file: NCA, tests: [T_AO],
    find: '  const lineOnVerifiedBy = inputs.armedLineOnVerifiedAtMs != null && Number.isFinite(inputs.armedLineOnVerifiedAtMs)\n',
    to: '  const lineOnVerifiedBy = (false as boolean) && inputs.armedLineOnVerifiedAtMs != null && Number.isFinite(inputs.armedLineOnVerifiedAtMs) /* MUTANT */\n',
    why: 'A run verified on every Core is still told the line is not assured for a switch-on that has happened.',
  },
  {
    id: 'AOA-12. ★★ every closeUnder worded lateStart',
    file: NCA, tests: [T_AO],
    find: "  const cushionEnvelopeReason: CushionEnvelopeReason | null = envelopeReasonOfChain === 'closeUnder' && lineLateStart ? 'lateStart' : envelopeReasonOfChain;",
    to: "  const cushionEnvelopeReason: CushionEnvelopeReason | null = envelopeReasonOfChain === 'closeUnder' ? 'lateStart' : envelopeReasonOfChain; /* MUTANT */",
    why: 'A night whose median walk closes under its line (2027-08-09 at ×0.944, 13 h) is told it is merely too close to it.',
  },
  {
    id: 'AOA-13. ★★★ lineNotHeldOf drops lateStart in line mode',
    file: NCA, tests: [T_AO, T_YEAR],
    find: "  if (!lineWalkHolds(p.expectedWriteLevelPct ?? null, l)) return 'closeUnder';\n  if (p.cushionEnvelopeReason === 'lateStart') return 'lateStart';\n",
    to: "  if (!lineWalkHolds(p.expectedWriteLevelPct ?? null, l)) return 'closeUnder';\n  /* MUTANT */\n",
    why: 'Every surface words a disclosed line night as held: the rationale, the push and the ARMED line say nothing.',
  },
  {
    id: 'AOA-13b. ★★★ lineNotHeldOf drops lateStart on a cost-carried night',
    file: NCA, tests: [T_AO, T_YEAR],
    find: "    // v1.205.0 — held on the median walk, not with the at-open allowance.\n    if (p.cushionEnvelopeReason === 'lateStart') return 'lateStart';\n",
    to: '    /* MUTANT */\n',
    why: 'A cost-carried night disclosed by the allowance is worded by nothing on the server.',
  },
  {
    id: 'AOA-14. ★★ the card\'s line-mode mirror drops lateStart',
    file: CARD, tests: [T_AO, T_YEAR],
    find: "  if (e != null && e < l - 0.05 - 1e-9) return 'closeUnder';\n  if (plan.cushionEnvelopeReason === 'lateStart') return 'lateStart';\n",
    to: "  if (e != null && e < l - 0.05 - 1e-9) return 'closeUnder';\n  /* MUTANT */\n",
    why: 'The card shows a disclosed line night as held.',
  },
  {
    id: 'AOA-14b. ★★ the card\'s cost mirror drops lateStart',
    file: CARD, tests: [T_AO, T_YEAR],
    find: "    const c = plan.expectedCloseAfterStopPct;\n    if (plan.cushionEnvelopeReason === 'lateStart') return 'lateStart';\n",
    to: '    const c = plan.expectedCloseAfterStopPct;\n    /* MUTANT */\n',
    why: 'The server and the card disagree on a cost-carried night.',
  },
  {
    id: 'AOA-14c. ★★ the card row\'s lateStart tail removed',
    file: CARD, tests: [T_AO],
    find: "        : kind === 'lateStart' ? ` — too close to the line to allow for ${plan.cushionLateStartAtOpen === true ? 'a late switch-on at the window open' : \"a late start of the window's charge\"}; residual risk remains` : '';",
    to: "        : ''; /* MUTANT */",
    why: 'A line-mode lateStart row reads as the force-charge\'s plain row: no disclosure on the card.',
  },
  {
    id: 'AOA-15. ★★★ the 21:30 push\'s lateStart branch removed',
    file: NTF, tests: [T_AO],
    find: "    if (kind === 'lateStart') {\n",
    to: "    if ((false as boolean)) { /* MUTANT */\n",
    why: 'The push falls back to "its force-charge runs, but the plan does not claim the line" with no reason.',
  },
  {
    id: 'AOA-15b. ★★ the push names a cost-carried night\'s stop as its close',
    file: NTF, tests: [T_AO],
    find: "      const e = plan.expectedForceChargeMode === 'line' ? plan.expectedWriteLevelPct : plan.expectedCloseAfterStopPct ?? null;",
    to: '      const e = plan.expectedWriteLevelPct; /* MUTANT */',
    why: '"expected to close at ~87%": the cost force-charge\'s stop, not the ~59.9% close past it.',
  },
  {
    id: 'AOA-15c. ★★ the push names no close on a cost-carried night (round 1: the rationale names ~59.9%, the push only the stop)',
    file: NTF, tests: [T_AO],
    find: "      const e = plan.expectedForceChargeMode === 'line' ? plan.expectedWriteLevelPct : plan.expectedCloseAfterStopPct ?? null;",
    to: "      const e = plan.expectedForceChargeMode === 'line' ? plan.expectedWriteLevelPct : null; /* MUTANT */",
    why: '2027-02-05 21:30 at ×0.944, 20 h: the push says the line is too close to "the expected close" and states only the ~87% stop.',
  },
  {
    id: 'AOA-16. ★★ the mid-day shadow restore drops lateStart',
    file: MSH, tests: [T_AO, T_LINE],
    find: " || o.lineNotHeld === 'nearFull' || o.lineNotHeld === 'lateStart' ? { lineNotHeld: o.lineNotHeld } : {}),",
    to: " || o.lineNotHeld === 'nearFull' ? { lineNotHeld: o.lineNotHeld } : {}), /* MUTANT */",
    why: 'After a restart the mid-day push loses its NOTE, silently.',
  },
  {
    id: 'AOA-16b. ★★ the mid-day push\'s lateStart NOTE removed',
    file: CTX, tests: [T_AO],
    find: "        : l.lineNotHeld === 'lateStart' ? ` NOTE: on the median load this leg's pool is expected to close too close to its outage line to allow for ${lateStartAllowanceWords(l.lateStartAtOpen)} — residual risk remains.`\n",
    to: '        /* MUTANT */\n',
    why: 'The mid-day leg says its force-charge runs and the line is not claimed, with no reason.',
  },
  {
    id: 'AOA-17. ★★ the line-mode ARMED tail removed',
    file: NFC, tests: [T_AO],
    find: "    : o.notHeld.kind === 'lateStart' ? lateStartArmTail(",
    to: "    : (false as boolean) /* MUTANT */ ? lateStartArmTail(",
    why: 'The 21:30 ARMED line says "Line NOT held" of a line the median walk holds.',
  },
  {
    id: 'AOA-17b. ★★ the cost ARMED tail removed',
    file: IDX, tests: [T_AO],
    find: COST_ARM,
    to: '  return eligible; /* MUTANT */',
    why: 'The cost-carried ARMED line says nothing of a disclosed line.',
  },
  {
    id: 'AOA-17d. ★★ the ARMED tail names no close (both ARMED lines)',
    file: NFC, tests: [T_AO],
    find: "  const close = closePct != null && Number.isFinite(closePct) ? `~${round1(closePct)}%` : 'a level near the line';",
    to: "  const close = 'a level near the line'; /* MUTANT */",
    why: 'The ARMED line names no close beside the rationale\'s ~59.9% (2027-02-05) and ~59.5% (2027-04-09).',
  },
  {
    id: 'AOA-18. ★★★ the assured walk skips cost-carried nights',
    file: NCA, tests: [T_AO],
    find: "  if (!(untilMs > fromMs) || (out.mode !== 'line' && out.rawClosePct == null)) return out;",
    to: "  if (!(untilMs > fromMs) || out.mode !== 'line') return out; /* MUTANT */",
    why: 'A cost-carried night at the open (2027-02-05 at ×0.944, 20 h) is claimed on its median walk alone.',
  },
  {
    id: 'AOA-19. ★★★ the allowance\'s end alone walked (no minute inside it)',
    file: NCA, tests: [T_AO],
    find: MINUTES,
    to: '  if ((false as boolean)) for (let m = fromMs + EXPECTED_JIT_STEP_MS; m <= untilMs; m += EXPECTED_JIT_STEP_MS) minutes.push(m); /* MUTANT */',
    why: 'The latching walk is not monotone: 2027-08-09 13:00 closes ~76.2% at +20 and ~69.1% at +5.',
  },
  {
    id: 'AOA-19b. ★★ a 5-minute grid, not every minute',
    file: NCA, tests: [T_AO],
    find: MINUTES,
    to: '  if (startMs != null && startMs <= untilMs) for (let m = fromMs + 5 * EXPECTED_JIT_STEP_MS; m <= untilMs; m += 5 * EXPECTED_JIT_STEP_MS) minutes.push(m); /* MUTANT */',
    why: 'The dip falls between its minutes: 2027-08-09 21:30 at ×0.944, 11 h closes ~65.6% at +12 min, ~66.9% at +15 (AO-13b).',
  },
  {
    id: 'AOA-19c. ★★ the minutes walked only for a start at the open (a median start inside the allowance gets its end alone)',
    file: NCA, tests: [T_AO],
    find: MINUTES,
    to: '  if (startMs === fromMs) for (let m = fromMs + EXPECTED_JIT_STEP_MS; m <= untilMs; m += EXPECTED_JIT_STEP_MS) minutes.push(m); /* MUTANT */',
    why: '2027-08-29 21:30 at ×0.944, 20 h, its force-charge from +5 min: ~91.0% at +12 min, ~91.5% at the allowance\'s end (AO-13c).',
  },
  {
    id: 'AOA-20. ★★ index.ts never passes the verified ON',
    file: IDX, tests: [T_AO],
    find: '    armedLineOnVerifiedAtMs: shadowLeg == null && opts.arming !== true ? armedLineRunOnSinceMs(nightActuationMem) : null,',
    to: '    armedLineOnVerifiedAtMs: null, /* MUTANT */',
    why: 'A run on every Core is disclosed as not assured until the allowance lapses.',
  },
  {
    id: 'AOA-20b. ★★★ buildNightChargeInputs drops the verified ON (index.ts hands it over; the plan never sees it)',
    file: NCA, tests: [T_AO],
    find: '    ...(armedLineOnVerifiedAtMs !== undefined ? { armedLineOnVerifiedAtMs } : {}),\n',
    to: '    /* MUTANT */\n',
    why: 'The production path: a run verified ON on every Core stays disclosed until the allowance lapses (the served path alone was tested).',
  },
  {
    id: 'AOA-21. ★★ the rationale\'s lateStart NOTE missing',
    file: NCA, tests: [T_AO, T_YEAR],
    find: "      : lineNotHeld === 'lateStart'\n        ? ` NOTE: on the median load",
    to: "      : (false as boolean) /* MUTANT */\n        ? ` NOTE: on the median load",
    why: 'A disclosed night\'s rationale says nothing of why.',
  },
  {
    id: 'AOA-22. ★★★ the allowance\'s end not walked where no minute inside it is (a median start past the allowance, or none: no assured close)',
    file: NCA, tests: [T_AO],
    find: '  if (minutes[minutes.length - 1] !== untilMs) minutes.push(untilMs);',
    to: '  if (minutes.length === 0) return out; /* MUTANT */',
    why: 'A night whose own start is past the allowance (2027-02-15 21:30 on nameplate, 18 h; G1\'s reserve leg done past it) is claimed on its median walk: the reach counted from the allowance\'s end is never read.',
  },
  {
    id: 'AOA-22b. ★★★ the deferral anchored at the walk\'s own start, reserveLeg.doneMs',
    file: NCA, tests: [T_AO],
    find: LINE_WALK_DEFER,
    to: "    acceptKw: o.window.acceptKw ?? null, noReOn: o.noReOn, runOn: o.runOn, standbyW: o.window.standbyW,\n    ...(o.onNotBeforeMs != null ? { onNotBeforeMs: o.onNotBeforeMs - o.window.fromMs + (reserveLeg.creditKwh > 0 ? reserveLeg.doneMs : o.window.fromMs) } : {}), /* MUTANT */",
    why: 'G1: a sunny mid-day leg whose reserve leg ends past the allowance is deferred a further 20 min from its own start, not to the allowance\'s end: its walk is no longer the median\'s.',
  },
  {
    id: 'AOA-23. ★★ the tolerance dropped from the assured check',
    file: NCA, tests: [T_AO],
    find: LATE,
    to: "  const lineLateStart = lineArmed && chargeTonight && !lineNearFull && !cushionShortfall && !lineCloseUnder\n    && expected.assuredClosePct !== undefined && expected.assuredClosePct != null && expected.assuredClosePct < cushionLineSocPct - 1e-9; /* MUTANT */",
    why: 'An assured close exactly at the line less 0.05 is disclosed: the claim\'s edge is not the scorer\'s.',
  },

  /* ── W: the words by one predicate (review) ── */
  {
    id: 'AOA-24. ★★★ every lateStart night worded as a switch-on at the window open (the start past the allowance ignored)',
    file: NCA, tests: [T_AO],
    find: '  const lineLateStartAtOpen = cushionEnvelopeReason === \'lateStart\' && lineAssureUntilMs != null\n    && expected.forceChargeStartMs != null && expected.forceChargeStartMs <= lineAssureUntilMs;',
    to: '  const lineLateStartAtOpen = cushionEnvelopeReason === \'lateStart\' && lineAssureUntilMs != null; /* MUTANT */',
    why: '2027-02-15 21:30 on nameplate, 18 h: "switches on at ~00:58" beside "a late switch-on at the window open".',
  },
  {
    id: 'AOA-24b. ★★ no lateStart night worded as a switch-on at the window open',
    file: NCA, tests: [T_AO],
    find: '  const lineLateStartAtOpen = cushionEnvelopeReason === \'lateStart\' && lineAssureUntilMs != null\n',
    to: '  const lineLateStartAtOpen = (false as boolean) && cushionEnvelopeReason === \'lateStart\' && lineAssureUntilMs != null /* MUTANT */\n',
    why: 'An at-open night (2027-04-09 at ×0.944, 7 h) loses the switch-on it is disclosed for.',
  },
  {
    id: 'AOA-24c. ★★ the rationale words ignore the predicate',
    file: NCA, tests: [T_AO],
    find: 'outage line to allow for ${lateStartAllowanceWords(lineLateStartAtOpen)}, so the cushion is not assured',
    to: 'outage line to allow for ${lateStartAllowanceWords(true)}, so the cushion is not assured /* MUTANT */',
    why: 'The rationale names a switch-on at the open its own Expected sentence puts at ~00:58.',
  },
  {
    id: 'AOA-24d. ★★ the 21:30 push words ignore the predicate',
    file: NTF, tests: [T_AO],
    find: '      const what = lateStartAllowanceWords(plan.cushionLateStartAtOpen);',
    to: '      const what = lateStartAllowanceWords(true); /* MUTANT */',
    why: 'The push names a switch-on at the window open on a night whose own force-charge start is past the allowance (2027-02-15, ~00:58).',
  },
  {
    id: 'AOA-24e. ★★ the card row ignores the predicate',
    file: CARD, tests: [T_AO],
    find: "allow for ${plan.cushionLateStartAtOpen === true ? 'a late switch-on at the window open' : \"a late start of the window's charge\"}; residual",
    to: "allow for ${'a late switch-on at the window open'}; residual /* MUTANT */",
    why: 'The card disagrees with the server on a night whose start is past the allowance.',
  },
  {
    id: 'AOA-24f. ★★ the mid-day summary drops the predicate',
    file: MSH, tests: [T_AO],
    find: "    ...(p?.cushionLateStartAtOpen === true && lineNotHeldOf(p) === 'lateStart' ? { lateStartAtOpen: true as const } : {}),\n",
    to: '    /* MUTANT */\n',
    why: 'An at-open mid-day leg is worded as a late start of the window\'s charge.',
  },
  {
    id: 'AOA-24g. ★★ the mid-day restore drops the predicate',
    file: MSH, tests: [T_AO],
    find: "    ...(o.lineNotHeld === 'lateStart' && o.lateStartAtOpen === true ? { lateStartAtOpen: true as const } : {}),\n",
    to: '    /* MUTANT */\n',
    why: 'After a restart the mid-day push words an at-open leg differently from the evening record.',
  },
  {
    id: 'AOA-24g2. ★ the mid-day restore keeps the predicate beside any kind',
    file: MSH, tests: [T_AO],
    find: "    ...(o.lineNotHeld === 'lateStart' && o.lateStartAtOpen === true ? { lateStartAtOpen: true as const } : {}),\n",
    to: "    ...(o.lateStartAtOpen === true ? { lateStartAtOpen: true as const } : {}), /* MUTANT */\n",
    why: 'A restored record carries a field its kind never has.',
  },
  {
    id: 'AOA-24h. ★★ the mid-day announce input drops the predicate',
    file: MSH, tests: [T_AO],
    find: '      ...(c.lateStartAtOpen === true ? { lateStartAtOpen: true as const } : {}),\n',
    to: '      /* MUTANT */\n',
    why: 'The mid-day push never names the switch-on at the open its leg is disclosed for.',
  },
  {
    id: 'AOA-24i. ★★ the mid-day push words ignore the predicate',
    file: CTX, tests: [T_AO],
    find: 'its outage line to allow for ${lateStartAllowanceWords(l.lateStartAtOpen)} — residual risk remains.`',
    to: 'its outage line to allow for ${lateStartAllowanceWords(true)} — residual risk remains.` /* MUTANT */',
    why: 'A leg whose start is past the allowance is told of a switch-on at the window open.',
  },
  {
    id: 'AOA-24j. ★★ the line-mode ARMED line is not told the predicate',
    file: IDX, tests: [T_AO],
    find: 'closePct: plan?.expectedWriteLevelPct ?? null, atOpen: plan?.cushionLateStartAtOpen === true } : null,',
    to: 'closePct: plan?.expectedWriteLevelPct ?? null } : null, /* MUTANT */',
    why: 'Every line-mode ARMED line names a late start of the window\'s charge, an at-open night included.',
  },
  {
    id: 'AOA-24k. ★★ the words helper ignores what the allowance defers',
    file: NFC, tests: [T_AO],
    find: "  return atOpen === true ? 'a late switch-on at the window open' : \"a late start of the window's charge\";",
    to: "  return 'a late switch-on at the window open'; /* MUTANT */",
    why: 'Every surface names a switch-on at the open, whatever the plan\'s own start.',
  },

  /* ── R: round 2 (review) ── */
  {
    id: 'AOA-25. ★★★ the close past the stop not carried beside lateStart (round 1)',
    file: NCA, tests: [T_AO],
    find: CLOSE_FIELD,
    to: '  const closeAfterStopField = lineArmed && lineCloseAfterStopPct != null && !lineWalkHolds(lineCloseAfterStopPct, cushionLineSocPct) /* MUTANT */',
    why: '2027-02-05 21:30 at ×0.944, 20 h: the push and the ARMED line name no close beside the rationale\'s ~59.9%.',
  },
  {
    id: 'AOA-25b. ★★ the close past the stop carried on every held cost-carried night',
    file: NCA, tests: [T_AO, T_MPW],
    find: CLOSE_FIELD,
    to: '  const closeAfterStopField = lineArmed && lineCloseAfterStopPct != null && (!lineWalkHolds(lineCloseAfterStopPct, cushionLineSocPct) || lineLateStart || true) /* MUTANT */',
    why: 'The field reads as a close under the line on a night that holds it: every consumer that keys on its presence (v1.202.0) misreads a carried night.',
  },
  {
    id: 'AOA-26. ★★ the H1 cap not recorded (the walk identity\'s guard cannot tell a capped close from a bound window)',
    file: NCA, tests: [T_AO, T_WALK],
    find: '      out.closeReachCapped = true;\n',
    to: '      /* MUTANT */\n',
    why: 'W1 lists walks left out of the identity as capped cost-carried closes; with no record of the cap its guard admits none of them.',
  },
  {
    id: 'AOA-26b. ★★ the H1 cap recorded on every bound cost-carried night (the round-1 guard)',
    file: NCA, tests: [T_AO],
    find: '    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;\n    if (out.rawClosePct > reachPct + 1e-9) {',
    to: '    const reachPct = (lineWindowReachKwh(o, deliverableKwh) / o.fullKwh) * 100;\n    out.closeReachCapped = true; /* MUTANT */\n    if (out.rawClosePct > reachPct + 1e-9) {',
    why: 'A bound night whose close past the stop is under the reach reads as capped: W1\'s guard admits a walk the cap never moved.',
  },

  /* ── F: round 3 (review) — a refused arm arms nothing ── */
  {
    id: 'AOA-27. ★★★ the refused 21:30 push states the armed night\'s line note',
    file: NTF, tests: [T_AO],
    find: '    const refusedNote = capsNote + refusedEnvelopeNote(plan);',
    to: '    const refusedNote = capsNote + envelopeShortfallNote(plan); /* MUTANT */',
    why: '2027-04-09 21:30 at ×0.944, 7 h, refused: "the add-on will not charge tonight", then the ~59.5% close of the 7.2 kWh charge it did not arm.',
  },
  {
    id: 'AOA-27b. ★★ the refused 21:30 push says nothing of a line night\'s line',
    file: NTF, tests: [T_AO],
    find: '  if (plan.forceChargeLine == null) return envelopeShortfallNote(plan);',
    to: "  if (plan.forceChargeLine == null) return envelopeShortfallNote(plan);\n  if ((true as boolean)) return ''; /* MUTANT */",
    why: 'A refused line night\'s push is silent on a line the 50% reserve cannot hold and nothing armed carries.',
  },
  {
    id: 'AOA-27c. ★★ the refused note names a line in (49, 50] above the 50% reserve',
    file: NTF, tests: [T_AO],
    find: "is above ${lineOverReserveText(l, 'accepts')}, and nothing is armed to carry it",
    to: "is above ${lineOverReserveText(Infinity /* MUTANT */, 'accepts')}, and nothing is armed to carry it",
    why: '2026-11-27 21:30 at ×0.944, 16 h: "the 49.99% outage line is above the 50% the panel accepts as a reserve".',
  },
  {
    id: 'AOA-27d. ★★★ the refused mid-day push states the armed leg\'s line note',
    file: CTX, tests: [T_AO],
    find: "    i.refused != null ? ` NOTE: this leg's outage line is above",
    to: "    /* MUTANT */ (false as boolean) ? ` NOTE: this leg's outage line is above",
    why: '"The add-on will not charge tomorrow", then the leg\'s close too close to its line to allow for a switch-on it did not arm.',
  },
  {
    id: 'AOA-27e. ★★ the refused mid-day note names a line in (49, 50] above the 50% reserve',
    file: CTX, tests: [T_AO],
    find: "lineOverReserveText(l.linePct ?? Infinity, 'accepts')",
    to: "lineOverReserveText(Infinity, 'accepts') /* MUTANT */",
    why: 'The overnight and mid-day refused notes disagree on a 49.99% line.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-line-at-open', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
