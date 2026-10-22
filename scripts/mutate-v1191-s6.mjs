#!/usr/bin/env node
/**
 * mutate-v1191-s6.mjs — v1.191.0 W1 and S6 (plan 3.4, CA15): the night charge plans in the tariff's
 * own cheap period, on a schedule derived from it.
 *
 * What this guards: every planner path resolves the model's cheap period (tariff.ts cheapPeriodIdOf),
 * never the APS id 'overnight' — the window, the horizon end, the cycle chooser, the long-gap scan and
 * the scorer's on-peak attribution (W1); and the evening job's catch-up cutoff, notify clamp,
 * stale-panel deferral, fallback night, full-window minimum and force-charge backstop come from
 * nightSchedule.ts, which keeps the APS constants verbatim on the preset (plan 6.4 item 5) and derives
 * them from the plan's own cheap window otherwise (S6).
 *
 *   W1-idx-cheap      index.ts plans in 'overnight' whatever the plan says
 *   W1-idx-window     index.ts resolves tonight's window on the APS id
 *   W1-idx-deps       the planner deps are given the APS id
 *   W1-idx-score      the scorer's on-peak attribution scans for the APS id
 *   W1-cw             chargeWindows.ts (chooser, horizon end) scans for the APS id
 *   W1-ledger         ledgerCheapPeriodIds ignores the cheap period
 *   W1-advisor-null   a plan with no cheap period is planned in a period called overnight
 *   S6-aps-derived    the APS preset derives its schedule (a 21:00 notify defers to 22:00, not 22:30)
 *   S6-cutoff         the catch-up cutoff stays 23:00 for every plan
 *   S6-clamp          the notify hour is not clamped before the cheap window
 *   S6-defer          the deferral stays 22:30 for every plan
 *   S6-maxrun         the backstop stays 7 h for every plan
 *   S6-full           the full-window minimum stays 3 h for every plan
 *   S6-noon           a window opening before noon is placed on the plan date, not the day after
 *   S6-fallback       the fallback night stays 23 / 29 / 45 h for every plan
 *   S6-offpeak        off_peak as the cheap period has no nominal window
 *   S6-tie            the off-peak tie is not broken toward the evening
 *   S6-fc-floor       the backstop can fall below 7 h
 *   S6-fc-ignored     decideForceCharge ignores the schedule's backstop
 *   S6-gate           the readiness diagnostic ignores the schedule's completion
 *   S6-longgap        the long-gap rule keeps the APS full-window minimum
 *   S6-idx-fire       the evening job fires at the configured time, unclamped
 *   S6-idx-cutoff     the evening job's cutoff is 23:00 again
 *   S6-idx-defer      the evening job defers until 22:30 again
 *   S6-idx-fallback   the scorer's fallback night is the APS one
 *   S6-idx-maxrun     the live force-charge tick passes no backstop
 *   S6-idx-failsafe   the force-charge tick throws when the tariff read does (no OFF decision)
 *   S6-idx-issue      the repair-issue route drops the notify clamp
 *   N-cw              the chooser and the horizon end resolve a run longer than a night as one window
 *   N-in-night        a cheap hour outside the nominal window counts as a window hour
 *   N-order           a run continues across the hour the next night opens
 *   N-dst             the repeated hour of a daylight-saving change ends the night
 *   N-utc             the night hour is read on the UTC clock
 *   N-aps             the APS preset is bounded too
 *   N-sizer           the sizer resolves the window without the bound
 *   N-nextfull        the long-gap scan steps over whole runs, not nights
 *   N-idx-bound       index.ts plans with no night bound
 *   N-idx-window      index.ts resolves tonight's window without the bound
 *   N-idx-deps        the planner deps lose the bound
 *   N-idx-nextfull    the long-gap scan in index.ts drops the bound
 *
 *   cd server && TSX_DISABLE_CACHE=1 MUTATE_CONCURRENCY=4 node ../scripts/mutate-v1191-s6.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = resolve(REPO, 'server/src/index.ts');
const CW = resolve(REPO, 'server/src/chargeWindows.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const SCHED = resolve(REPO, 'server/src/nightSchedule.ts');
const FC = resolve(REPO, 'server/src/nightForceCharge.ts');
const GATE = resolve(REPO, 'server/src/nightChargeGate.ts');
const SUBSET = [
  'test/nightCheapPeriod.test.ts',
  'test/nightWindowPerNight.test.ts',
  'test/nightSchedule.test.ts',
  'test/golden.test.ts',
  'test/legacyIdentity.test.ts',
  'test/ledgerMiddayShadow.test.ts',
  'test/ledgerOnPeakGoverned.test.ts',
  'test/longGapCeiling.test.ts',
  'test/nightForceCharge.test.ts',
  'test/nightPlanPanelFreshness.test.ts',
  'test/chargeWindows.test.ts',
  'test/tariffPlan.test.ts',
];

const MUTANTS = [
  {
    id: 'W1-idx-cheap. ★★★ index.ts plans in overnight whatever the plan says',
    file: IDX,
    find: '  const cheapPeriodId = cheapPeriodIdOf(tariffModel);',
    to: "  const cheapPeriodId: string | null = 'overnight'; /* MUTANT */",
    why: 'A custom plan whose cheap period has another name gets no window: "hold (no charge window)" every night.',
  },
  {
    id: 'W1-idx-window. ★★ tonight\'s window is resolved on the APS id',
    file: IDX,
    find: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30, cheapNight);',
    to: "    : resolveCheapWindow(periodIdAt, nowMs, 'overnight', 30, cheapNight); /* MUTANT */",
    why: 'The morning surplus, the long gap and the confidence horizon are measured from no window.',
  },
  {
    id: 'W1-idx-deps. ★★★ the planner is given the APS id',
    file: IDX,
    find: '    periodIdAt, cheapPeriodId, cheapNight, windowScanHours: 30,',
    to: "    periodIdAt, cheapPeriodId: 'overnight', cheapNight, windowScanHours: 30, /* MUTANT */",
    why: 'The sizer resolves no window on a custom plan, or the dearer period called overnight.',
  },
  {
    id: 'W1-idx-score. ★★ the scorer attributes the on-peak with the APS id',
    file: IDX,
    find: '    const cheapId = cheapPeriodIdOf(tariff);',
    to: "    const cheapId: string | null = 'overnight'; /* MUTANT */",
    why: 'A Friday night claims Monday\'s on-peak and its cost on a custom plan.',
  },
  {
    id: 'W1-cw. ★★★ the chooser and the horizon end scan for the APS id',
    file: CW,
    find: '  const cheapId = cheapPeriodIdOf(model);',
    to: '  const cheapId = APS_PERIOD.OVERNIGHT as string | null; /* MUTANT */',
    why: 'nextRechargeMs is null on a custom plan (no horizon end), and the misnamed plan charges in the dearer period.',
  },
  {
    id: 'W1-ledger. ★★ ledgerCheapPeriodIds ignores the cheap period',
    file: NLS,
    find: '  const own = cheapPeriodId == null ? [] : [cheapPeriodId];',
    to: "  const own = ['overnight']; /* MUTANT */",
    why: 'As W1-idx-score, at the pure helper.',
  },
  {
    id: 'W1-advisor-null. ★★ no cheap period is planned in a period called overnight',
    file: NCA,
    find: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, windowScanHours, cheapNight);',
    to: "    : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId ?? 'overnight', windowScanHours, cheapNight); /* MUTANT */",
    why: 'A plan that names no night-charge period is charged in whatever period carries the APS name.',
  },
  {
    id: 'S6-aps-derived. ★★★ the APS preset derives its schedule',
    file: SCHED,
    find: '  const nominal = isApsOvernightSchedule(model) ? null : nominalCheapWindow(model);',
    to: '  const nominal = nominalCheapWindow(model); /* MUTANT */',
    why: 'The reference install changes with its options unchanged: a 21:00 notify defers to 22:00, not 22:30 (plan 6.4 item 5).',
  },
  {
    id: 'S6-cutoff. ★★★ the catch-up cutoff stays 23:00 for every plan',
    file: SCHED,
    find: '    eveningCutoffMin: Math.min(openMin, MIDNIGHT_MIN),',
    to: '    eveningCutoffMin: 23 * 60, /* MUTANT */',
    why: 'A 22:00 window: a restart at 22:10 plans and arms inside the window (the announced cancel time has passed).',
  },
  {
    id: 'S6-clamp. ★★★ the notify hour is not clamped before the window',
    file: SCHED,
    find: '  const hour = Math.min(configured.hour, notifyHourMax);',
    to: '  const hour = configured.hour; /* MUTANT */',
    why: 'A 21:00 window planned at 21:30: every supervised arm is refused (the window opened 30 min earlier).',
  },
  {
    id: 'S6-defer. ★★ the deferral stays 22:30 for every plan',
    file: SCHED,
    find: '    staleDeferUntilMin: Math.min(fireMin + 60, openMin - 30),',
    to: '    staleDeferUntilMin: NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, /* MUTANT */',
    why: 'A 22:00 window: a stale panel defers the plan past the open, and the arm is refused.',
  },
  {
    id: 'S6-maxrun. ★★ the backstop stays 7 h for every plan',
    file: SCHED,
    find: '    forceChargeMaxRunMs: Math.max(FORCE_CHARGE_MAX_RUN_MS, nominal.lengthHours * HOUR_MS + HOUR_MS),',
    to: '    forceChargeMaxRunMs: FORCE_CHARGE_MAX_RUN_MS, /* MUTANT */',
    why: 'A 9 h window\'s force-charge is cut off at 7 h.',
  },
  {
    id: 'S6-full. ★★ the full-window minimum stays 3 h for every plan',
    file: SCHED,
    find: '    fullWindowMinMs: Math.min(FULL_CHEAP_WINDOW_MIN_MS, nominal.lengthHours * HOUR_MS),',
    to: '    fullWindowMinMs: FULL_CHEAP_WINDOW_MIN_MS, /* MUTANT */',
    why: 'A 2 h cheap window never counts as a recharge: every night reads as the start of a long gap (CA15).',
  },
  {
    id: 'S6-noon. ★★ a window opening before noon is placed on the plan date',
    file: SCHED,
    find: '  const openMin = (nominal.startHour < NOON_MIN / 60 ? nominal.startHour + 24 : nominal.startHour) * 60;',
    to: '  const openMin = nominal.startHour * 60; /* MUTANT */',
    why: 'A 00:00 window clamps the notify to before midnight of the day before and the catch-up never opens.',
  },
  {
    id: 'S6-fallback. ★★ the fallback night stays the APS one',
    file: SCHED,
    find: '    fallbackNight: { windowStartMin: openMin, windowEndMin: closeMin, completeMin: closeMin + SCORE_SPAN_AFTER_CLOSE_MS / MINUTE_MS },',
    to: '    fallbackNight: { ...APS_NIGHT_SCHEDULE.fallbackNight }, /* MUTANT */',
    why: 'A row with no stored window is scored and completed on the APS night (plan 3.4 W4).',
  },
  {
    id: 'S6-offpeak. ★ off_peak as the cheap period has no nominal window',
    file: CW, // v1.191.0 (review) — nominalCheapWindow moved to chargeWindows.ts
    find: '  if (id !== model.offPeak.id) return null;',
    to: '  if (id !== model.offPeak.id || id === model.offPeak.id) return null; /* MUTANT */',
    why: 'A two-tier plan with NIGHT_CHARGE_CHEAP_PERIOD=off_peak keeps the APS clock and plans inside its 19:00 window.',
  },
  {
    id: 'S6-tie. ★ the off-peak tie is not broken toward the evening',
    file: CW,
    find: '(n === best.lengthHours && afterNoon(h) < afterNoon(best.startHour))',
    to: '(false /* MUTANT */)',
    why: 'Two equal off-peak runs: the morning one is taken as the night.',
  },
  {
    id: 'S6-fc-floor. ★★★ the backstop can fall below 7 h',
    file: FC,
    find: '  return v != null && Number.isFinite(v) ? Math.max(FORCE_CHARGE_MAX_RUN_MS, v) : FORCE_CHARGE_MAX_RUN_MS;',
    to: '  return v != null && Number.isFinite(v) ? v : FORCE_CHARGE_MAX_RUN_MS; /* MUTANT */',
    why: 'A schedule value under 7 h cuts every APS-length charge short.',
  },
  {
    id: 'S6-fc-ignored. ★★ decideForceCharge ignores the schedule\'s backstop',
    file: FC,
    find: "  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= forceChargeRunCapMs(o)) return 'maxRun';",
    to: "  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= FORCE_CHARGE_MAX_RUN_MS) return 'maxRun'; /* MUTANT */",
    why: 'As S6-maxrun, at the decision.',
  },
  {
    id: 'S6-gate. ★ the readiness diagnostic ignores the schedule\'s completion',
    file: GATE,
    find: '      const lastComplete = siteYmd(nowMs - (opts?.completeAfterMs ?? 45 * 3_600_000));',
    to: '      const lastComplete = siteYmd(nowMs - 45 * 3_600_000); /* MUTANT */',
    why: 'A later-completing night counts as missing in the exclusion diagnostic.',
  },
  {
    id: 'S6-longgap. ★★ the long-gap rule keeps the APS full-window minimum',
    file: NCA,
    find: '  if (!tonight || tonight.endMs - tonight.startMs < minFullMs) return false;',
    to: '  if (!tonight || tonight.endMs - tonight.startMs < FULL_CHEAP_WINDOW_MIN_MS) return false; /* MUTANT */',
    why: 'A 2 h nightly window is never a full night for the Thursday rule.',
  },
  {
    id: 'S6-idx-fire. ★★★ the evening job fires at the configured time, unclamped',
    file: IDX,
    find: '  const fireMin = sched.notify.fireMin;\n  const cutoffMin = sched.eveningCutoffMin;',
    to: '  const fireMin = NIGHT_CHARGE_NOTIFY_HOUR * 60 + NIGHT_CHARGE_NOTIFY_MINUTE; /* MUTANT */\n  const cutoffMin = sched.eveningCutoffMin;',
    why: 'The schedule is computed and never reaches the evening job: a 19:00 window is planned inside it.',
  },
  {
    id: 'S6-idx-cutoff. ★★ the evening job\'s cutoff is 23:00 again',
    file: IDX,
    find: '  const cutoffMin = sched.eveningCutoffMin; // catch-up window [fire, cutoff): 23:00 on the APS preset',
    to: '  const cutoffMin = 23 * 60; /* MUTANT */',
    why: 'As S6-cutoff, at the evening job.',
  },
  {
    id: 'S6-idx-defer. ★★ the evening job defers until 22:30 again',
    file: IDX,
    find: '  const deferUntilMin = sched.staleDeferUntilMin;',
    to: '  const deferUntilMin = 22 * 60 + 30; /* MUTANT */',
    why: 'As S6-defer, at the evening job.',
  },
  {
    id: 'S6-idx-fallback. ★ the scorer\'s fallback night is the APS one',
    file: IDX,
    find: '  const b = nightWindowBounds(String(y.plan_date), nightScheduleNow().fallbackNight);',
    to: '  const b = nightWindowBounds(String(y.plan_date)); /* MUTANT */',
    why: 'As S6-fallback, at the scorer.',
  },
  {
    id: 'S6-idx-maxrun. ★★ the live force-charge tick passes no backstop',
    file: IDX,
    find: '    // v1.191.0 (S6, W5) — the run backstop of the tariff in effect: 7 h on the APS preset.\n    maxRunMs: forceChargeMaxRunNow(),',
    to: '    /* MUTANT */',
    why: 'The schedule\'s backstop is tested and never reached: a 9 h window is still cut at 7 h.',
  },
  {
    id: 'S6-idx-failsafe. ★★ the force-charge tick throws when the tariff read does',
    file: IDX,
    find: '  try { return nightScheduleNow().forceChargeMaxRunMs; } catch { return FORCE_CHARGE_MAX_RUN_MS; }',
    to: '  return nightScheduleNow().forceChargeMaxRunMs; /* MUTANT */',
    why: 'A tariff read that fails stops the minute tick before it decides: a force-charge of ours is not switched off.',
  },
  {
    id: 'S6-idx-issue. ★ the repair-issue route drops the notify clamp',
    file: IDX,
    find: '  report.issues.push(...nightScheduleRepairIssues(nightScheduleNow(), report.generatedAt));',
    to: '  /* MUTANT */',
    why: 'A clamped notify time is applied silently; the operator never learns the evening job moved.',
  },
  // ── v1.191.0 (review) — a charge window is one night of the cheap period (chargeWindows.ts cheapNightOf) ──
  {
    id: 'N-cw. ★★★ the chooser and the horizon end resolve a run longer than a night as one window',
    file: CW,
    find: '  return cheapId == null ? null : resolveCheapWindow(periodIdAt, fromMs, cheapId, scanHours, cheapNightOf(model));',
    to: '  return cheapId == null ? null : resolveCheapWindow(periodIdAt, fromMs, cheapId, scanHours); /* MUTANT */',
    why: 'Off-peak as the cheap period with Mon–Fri on-peak: Saturday and Sunday plan a window that opened a day earlier, a write mode refuses it, and Monday\'s on-peak starts on Friday\'s charge.',
  },
  {
    id: 'N-in-night. ★★★ a cheap hour outside the nominal window counts as a window hour',
    file: CW,
    find: '    && (night == null || night.nightHourAt(t) < night.lengthHours);',
    to: '    && (night == null || true); /* MUTANT */',
    why: 'The Saturday 18:30 plan starts inside the weekend run and walks back to Friday 19:00.',
  },
  {
    id: 'N-order. ★★ a run continues across the hour the next night opens',
    file: CW,
    find: '    && (night == null || night.nightHourAt(b) >= night.nightHourAt(a));',
    to: '    && (night == null || true); /* MUTANT */',
    why: 'A cheap period that covers the whole day is one window of 25 h or more, walking back across midnight.',
  },
  {
    id: 'N-dst. ★★ the repeated hour of a daylight-saving change ends the night',
    file: CW,
    find: '    && (night == null || night.nightHourAt(b) >= night.nightHourAt(a));',
    to: '    && (night == null || night.nightHourAt(b) > night.nightHourAt(a)); /* MUTANT */',
    why: 'On the fall-back night the window stops at the second 01:00, and the rest of the night is a second window.',
  },
  {
    id: 'N-utc. ★★ the night hour is read on the UTC clock',
    file: CW,
    find: '  return { lengthHours, nightHourAt: (t) => (localParts(t, model.timezone).hour - startHour + 24) % 24 };',
    to: '  return { lengthHours, nightHourAt: (t) => (new Date(t).getUTCHours() - startHour + 24) % 24 }; /* MUTANT */',
    why: 'The nightly window is shifted by the zone offset: a 19:00 window opens at 12:00 in Phoenix.',
  },
  {
    id: 'N-aps. ★★★ the APS preset is bounded too',
    file: CW,
    find: '  if (isApsOvernightSchedule(model)) return null;\n  const nominal = nominalCheapWindow(model);',
    to: '  const nominal = nominalCheapWindow(model); /* MUTANT */',
    why: 'The reference install\'s resolver gains a bound it never had (the G4 golden is computed through it).',
  },
  {
    id: 'N-sizer. ★★★ the sizer resolves the window without the bound',
    file: NCA,
    find: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, windowScanHours, cheapNight);',
    to: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, windowScanHours, cheapNight && null); /* MUTANT */',
    why: 'index.ts passes the bound and the sizer drops it: the plan sizes and arms the run in progress, opened 30 h earlier.',
  },
  {
    id: 'N-nextfull. ★★ the long-gap scan steps over whole runs, not nights',
    file: NCA,
    find: '    const w = resolveCheapWindow(periodIdAt, from, cheapPeriodId, Math.max(1, Math.ceil((limitMs - from) / HOUR_MS)), night);',
    to: '    const w = resolveCheapWindow(periodIdAt, from, cheapPeriodId, Math.max(1, Math.ceil((limitMs - from) / HOUR_MS))); /* MUTANT */',
    why: 'The next full window after Friday\'s is read as the weekend run already in progress.',
  },
  {
    id: 'N-idx-bound. ★★★ index.ts plans with no night bound',
    file: IDX,
    find: '  const cheapNight = cheapNightOf(tariffModel);',
    to: '  const cheapNight = null; /* MUTANT */',
    why: 'As N-cw, at the live plan: the evening plan and the sizer resolve the weekend as one window.',
  },
  {
    id: 'N-idx-window. ★★ index.ts resolves tonight\'s window without the bound',
    file: IDX,
    find: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30, cheapNight);',
    to: '    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30); /* MUTANT */',
    why: 'The horizon end and the morning surplus are measured from the weekend run, while the sizer plans one night.',
  },
  {
    id: 'N-idx-deps. ★★★ the planner deps lose the bound',
    file: IDX,
    find: '    periodIdAt, cheapPeriodId, cheapNight, windowScanHours: 30,',
    to: '    periodIdAt, cheapPeriodId, windowScanHours: 30, /* MUTANT */',
    why: 'An input computed and never passed (the v1.125.0 trap): the sizer resolves the weekend as one window.',
  },
  {
    id: 'N-idx-nextfull. ★ the long-gap scan in index.ts drops the bound',
    file: IDX,
    find: 'nextFullCheapWindow(periodIdAt, window.endMs, cheapPeriodId, 120, nightSched.fullWindowMinMs, cheapNight)',
    to: 'nextFullCheapWindow(periodIdAt, window.endMs, cheapPeriodId, 120, nightSched.fullWindowMinMs) /* MUTANT */',
    why: 'Friday\'s next full window is read as the weekend run in progress.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1191-s6', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
