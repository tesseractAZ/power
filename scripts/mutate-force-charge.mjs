#!/usr/bin/env node
/**
 * mutate-force-charge.mjs — committed harness for the v1.165.0 night force-charge
 * (server/src/nightForceCharge.ts, its state in nightChargeActuator.ts, its driver in
 * index.ts, and its own-write rule in settingsDrift.ts).
 *
 * WHY COMMITTED: force-charge ("Charge Now") is the control behind the 2026-08-04
 * on-peak buy — left ON, it buys grid power at the day's highest rate for hours. The
 * rails that switch it OFF are each one comparison wide, and every one of them is the
 * difference between a cheap overnight top-up and an expensive afternoon. Each mutant
 * below reverts ONE rail; the suite must kill it by a named assertion.
 *
 *   node scripts/mutate-force-charge.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const FC = resolve(SERVER, 'src/nightForceCharge.ts');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const DRIFT = resolve(SERVER, 'src/settingsDrift.ts');
const NCA = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const NOTIFY = resolve(SERVER, 'src/notify.ts');

const SUBSET = ['test/nightForceCharge.test.ts', 'test/longGapCeiling.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ OFF only when the feature is still enabled',
    file: FC,
    find: '  if (s.forceChargeOnAtMs != null && s.forceChargeOffAtMs == null) {\n    const reason = offReason(s, nowMs, o);',
    to: '  if (s.forceChargeOnAtMs != null && s.forceChargeOffAtMs == null && o.enabled) { /* MUTANT */\n    const reason = offReason(s, nowMs, o);',
    why: 'An owner who disables the feature mid-night strands a force-charge already running — the switch-off path must never depend on the switch-on gate.',
  },
  {
    id: 'ii. ★★★ the window end no longer switches it off',
    file: FC,
    find: '  if (s.windowEndMs == null || nowMs >= s.windowEndMs) return \'windowEnd\';',
    to: '  if (s.windowEndMs == null) return \'windowEnd\'; /* MUTANT */',
    why: 'Force-charge runs on past 05:00 into the day — the 2026-08-04 on-peak buy, rebuilt.',
  },
  {
    id: 'iii. ★★★ ON starts on an UNKNOWN grid',
    file: FC,
    find: '  if (o.gridPresent !== true || o.gridStaLost) { // unknown grid never starts a grid charge',
    to: '  if (o.gridPresent === false) { /* MUTANT */',
    why: 'A grid charge is started with no evidence the grid is there — and the panel\'s own gridSta=0 veto is ignored.',
  },
  {
    id: 'iv. ★★ ON takes ownership of an operator\'s Charge Now',
    file: FC,
    find: '  if (o.slotsOn.length > 0) return { kind: \'none\', why: `Charge Now is already ON for slot(s) ${o.slotsOn.join(\', \')} — that is the operator\'s, never taken over` }; // someone else\'s Charge Now — never take ownership',
    to: '  /* MUTANT */',
    why: 'The add-on adopts a force-charge the owner switched on deliberately, then switches it OFF at 05:00 behind his back.',
  },
  {
    id: 'v. ★★ ON rides an UNVERIFIED reserve write',
    file: FC,
    find: '  if (s.appliedAtMs == null || s.applyVerifiedAtMs == null) return { kind: \'none\', why: \'waiting for the reserve write to be verified by readback\' };',
    to: '  if (s.appliedAtMs == null) return { kind: \'none\' }; /* MUTANT */',
    why: 'Force-charge starts on the night the write path is least proven to be working (the 2026-08-16 phantom shape).',
  },
  {
    id: 'vi. ★★★ verification stops after the escalation (wedges every later night)',
    file: FC,
    find: '    if (stillOn.length === 0) return { kind: \'offVerified\' };',
    to: '    if (stillOn.length === 0 && !s.forceChargeOffEscalated) return { kind: \'offVerified\' }; /* MUTANT */',
    why: 'Once escalated the record can never resolve, and armFromPlan refuses to re-arm on top of it — night-charging silently stops for good.',
  },
  {
    id: 'vii. ★★★ an empty slot list verifies as "nothing still on"',
    file: FC,
    find: '  const ours = s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? s.forceChargeSlots : [1, 2, 3];',
    to: '  const ours = s.forceChargeSlots ?? []; /* MUTANT */',
    why: 'A restart that loses the slot list switches NOTHING off and then verifies it — a force-charge left running with the record saying clean.',
  },
  {
    id: 'viii. ★★ the panel\'s gridSta=0 no longer switches it off',
    file: FC,
    find: '  if (o.gridPresent === false || o.gridStaLost) return \'gridLoss\';',
    to: '  if (o.gridPresent === false) return \'gridLoss\'; /* MUTANT */',
    why: 'The independent device-side grid-loss signal is dropped; force-charge stays ON through an outage the resolver has not yet declared.',
  },
  {
    id: 'ix. ★★ no MAX_RUN backstop',
    file: FC,
    find: '  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= FORCE_CHARGE_MAX_RUN_MS) return \'maxRun\';',
    to: '  /* MUTANT */',
    why: 'A corrupted window end holds force-charge on indefinitely.',
  },
  {
    id: 'x. ★★ ON before the overnight window opens',
    file: FC,
    find: '  if (nowMs < s.windowStartMs) return { kind: \'none\', why: \'the overnight window has not opened yet\' };',
    to: '  /* MUTANT */',
    why: 'Force-charge starts at the 22:55 apply, before the overnight rate begins at 23:00.',
  },
  {
    id: 'xi. ★★ the verify grace drops under the per-slot cooldown',
    file: FC,
    find: 'export const FORCE_CHARGE_OFF_VERIFY_AFTER_MS = 6 * 60_000;',
    to: 'export const FORCE_CHARGE_OFF_VERIFY_AFTER_MS = 3 * 60_000; /* MUTANT */',
    why: 'Every OFF retry comes back rate-limited, the budget is spent on writes that never reach the panel, and a slow readback escalates as "stuck ON".',
  },
  {
    id: 'xii. ★★★ arming buries a force-charge whose OFF never verified',
    file: ACT,
    find: '  if (prev.forceChargeOnAtMs != null && prev.forceChargeOffVerifiedAtMs == null) return null;',
    to: '  /* MUTANT */',
    why: 'The next 21:30 arming returns a fresh record and erases the only record that knows to switch the stuck force-charge off.',
  },
  {
    id: 'xiii. ★★★ the force-charge step is never called',
    file: IDX,
    find: '    await runForceChargeTick();',
    to: '    /* MUTANT */',
    why: 'Nothing ever switches force-charge off — every guard above is dead code.',
  },
  {
    id: 'xiv. ★★ settings-drift launders an operator\'s Charge Now',
    file: DRIFT,
    find: '    return act.forceChargeActive === true ? \'own-write\' : \'external\';',
    to: '    return \'own-write\'; /* MUTANT */',
    why: 'The watchdog built after 2026-08-04 stops reporting the exact change it exists to catch.',
  },
  {
    id: 'xvi. ★★ arming stops capturing the announced ceiling',
    file: ACT,
    find: '        ? plan.costCeilingSocPct : null,',
    to: '        ? null : null, /* MUTANT */',
    why: 'Every night arms with no ceiling, so force-charge never starts — the feature silently does nothing.',
  },
  {
    id: 'xvii. ★★ the economic ceiling ignores the morning solar forecast',
    file: NCA,
    find: '  const ceilingKwh = pvCap != null ? Math.min(socCap, pvCap) : socCap;',
    to: '  const ceilingKwh = socCap; /* MUTANT */',
    why: 'The planner and the force-charge both fill to the raw owner ceiling on a sunny morning, curtailing solar the forecast saw coming.',
  },
  // ── the pre-merge review's fixes (v1.165.0) — each must stay pinned ──
  {
    id: 'xviii. ★★★ the escalation STOPS the OFF writes (the first cut\'s defect)',
    file: FC,
    find: '      return since >= FORCE_CHARGE_OFF_PERSIST_EVERY_MS ? { kind: \'offRetry\', slots: stillOn } : { kind: \'none\' };',
    to: '      return { kind: \'none\' }; /* MUTANT */',
    why: 'A command path failing for ~18 min at 05:00 leaves force-charge ON through the weekday into the 16:00 on-peak, with one push as the only signal.',
  },
  {
    id: 'xix. ★★★ ON on a ceiling that has not read back',
    file: FC,
    find: '  if (o.ceilingReadbackPct !== desired) {',
    to: '  if (false) { /* MUTANT */',
    why: 'ON fires on an unverified ceiling write and the panel fills to whatever it holds (100 live) — past the owner\'s 90 and past the solar headroom.',
  },
  {
    id: 'xx. ★★★ the panel\'s own ceiling is never restored',
    file: FC,
    find: '  if (forceDone && s.forceChargeCeilingPriorPct != null && s.forceChargeCeilingRestoredAtMs == null) {',
    to: '  if (false) { /* MUTANT */',
    why: 'Every later manual Charge Now — including storm prep — silently stops at tonight\'s 80-90 instead of 100, and nothing says so.',
  },
  {
    id: 'xxi. ★★ an unrestored original is not carried into the next night',
    file: ACT,
    find: '        ? prev.forceChargeCeilingPriorPct : null,',
    to: '        ? null : null, /* MUTANT */',
    why: 'After one failed restore, the next night captures OUR leftover 90 as "the panel\'s own" and restores to it — the owner\'s 100 is lost for good.',
  },
  {
    id: 'xxii. ★★★ the master-switch safety tick never switches it off',
    file: IDX,
    find: '  runForceChargeTick({ forceDisabled: true })',
    to: '  Promise.resolve() /* MUTANT */',
    why: 'Flipping NIGHT_CHARGE_ADVISOR_ENABLED off mid-night removes the only timer, and force-charge stays ON with nothing to stop it.',
  },
  {
    id: 'xxiii. ★★★ islanded (gridSta 2) is read as grid-connected',
    file: IDX,
    find: "    gridStaLost: sp != null && typeof sp.gridSta === 'number' && sp.gridSta !== 1,",
    to: "    gridStaLost: sp?.gridSta === 0, /* MUTANT */",
    why: 'The panel\'s own islanded flag — the outage case itself — never switches force-charge off.',
  },
  {
    id: 'xxiv. ★★ a rejected OFF spends the readback budget',
    file: IDX,
    find: '    if (isRetry && acked > 0) {',
    to: '    if (isRetry) { /* MUTANT */',
    why: 'OFF writes that never reached the panel escalate a force-charge as "ignoring us", and burn the retries a real readback failure needs.',
  },
  // ── v1.166.0 — "chose not to" vs "broke" ──
  // ── v1.167.0 — charge to target, just in time. These replace xv/xxv, which pinned the
  // v1.165.0 "under the panel's 80% minimum ⇒ reserve-only" rule the owner retired.
  {
    id: 'xv. ★★★ just-in-time is removed (starts at the window open, then the house drains it)',
    file: FC,
    find: '  if (nowMs < forceChargeStartAtMs(s.windowEndMs!, target, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh)) { // window checked above',
    to: '  if (false) { /* MUTANT */',
    why: 'Force-charge reaches the target at ~02:00 and the house draws the pack back toward the 50% reserve for three hours — ~57% at dawn instead of 64%.',
  },
  {
    id: 'xxv. ★★★ it does not stop at the target',
    file: FC,
    // v1.170.0 — repointed: the stop applies at every target again (forceChargeStopPct).
    find: '    && o.poolSocPct >= forceChargeStopPct(s.forceChargeCeilingPct)',
    to: '    && false /* MUTANT */',
    why: 'Force-charge runs on to the panel\'s backstop ceiling — past the owner\'s target and past the morning-solar headroom.',
  },
  {
    id: 'xxvii. ★★ a target at or below the reserve still force-charges',
    file: FC,
    find: '  if (target <= RESERVE_WRITE_MAX_PCT) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A night the reserve alone covers still switches force-charge on — two writes and an on-peak hazard for nothing.',
  },
  {
    id: 'xxviii. ★★ the plan rate is raised to the measured peak (starts too late)',
    file: FC,
    find: 'export const FORCE_CHARGE_PLAN_RATE_KW = 10;',
    to: 'export const FORCE_CHARGE_PLAN_RATE_KW = 40; /* MUTANT */',
    why: 'The start is timed for a rate the pack does not reach with an EV on the grid input, so the night ends short of the target.',
  },
  {
    id: 'xxix. ★★ the waiting reason changes every tick',
    file: FC,
    find: "    return { kind: 'none', why: `just in time — holding off so the pack reaches ${target}% as the window closes, not hours early (which would let the house draw it back toward the reserve)` };",
    to: "    return { kind: 'none', why: `just in time — starting at ${forceChargeStartAtMs(s.windowEndMs!, target, o.poolSocPct, o.fullKwh)}` }; /* MUTANT */",
    why: 'The logged reason includes a start time that moves with the SoC, so the once-per-reason log writes a line every minute of the night.',
  },
  // ── v1.168.0 — coast on grid at 80+, the wall-clock OFF deadline, the Thursday rule
  // and the median surplus.
  {
    // v1.170.0 — REPLACES the v1.168.0 coast mutant: the owner retired the coast (measured
    // 2026-09-18, the panel did not hold the house on grid at its ceiling).
    id: 'xxx. ★★★ the coast returns: an 80+ target is left on past the target',
    file: FC,
    find: '    && o.poolSocPct >= forceChargeStopPct(s.forceChargeCeilingPct)',
    to: '    && s.forceChargeCeilingPct < 80 && o.poolSocPct >= forceChargeStopPct(s.forceChargeCeilingPct) /* MUTANT */',
    why: 'Charge Now stays on from ~03:30 to 05:00 while the house draws the pack back — hours of exposure for nothing.',
  },
  {
    // v1.170.0 — REPLACES the coast-boundary mutant (property retired).
    id: 'xxxi. ★★ the stop chases an 85.3 target the whole-number SoC never reaches',
    file: FC,
    find: '  return Math.min(targetPct, desiredForceChargeCeilingPct(targetPct));',
    to: '  return targetPct; /* MUTANT */',
    why: 'The panel stops at its 85 ceiling, the pool reads 85, the stop wants 85.3 — Charge Now stays on to 05:00.',
  },
  {
    id: 'xxxii. ★★★ the wall-clock deadline is removed',
    file: FC,
    find: '  if (s.forceChargeOffDeadlinePagedAtMs == null) {\n    const deadline = forceChargeOffDeadlineMs(s);',
    to: '  if (false) { /* MUTANT */\n    const deadline = forceChargeOffDeadlineMs(s);',
    why: 'A stale readback or a cloud that keeps refusing the OFF leaves force-charge on into the on-peak in silence — the verify loop waits forever.',
  },
  {
    id: 'xxxiii. ★★ the deadline takes the EARLIER bound',
    file: FC,
    find: '  return fromOff != null ? Math.max(fromOff, fromWindow) : fromWindow;',
    to: '  return fromOff != null ? Math.min(fromOff, fromWindow) : fromWindow; /* MUTANT */',
    why: 'A 03:00 target OFF slow to verify pages the house at 03:30 over a force-charge that costs nothing extra inside the cheap window.',
  },
  {
    id: 'xxxiv. ★★★ the deadline only counts from an OFF that was sent',
    file: FC,
    find: '  return fromOff != null ? Math.max(fromOff, fromWindow) : fromWindow;',
    to: '  return fromOff; /* MUTANT */',
    why: 'A tick that never ran at 05:00 never sends the OFF, so the deadline never starts — the one case it exists for.',
  },
  {
    id: 'xxxv. ★★ past the deadline, slots reading OFF are escalated instead of verified',
    file: FC,
    find: "      if (stillOn.length > 0) return { kind: 'offFailed', slots: stillOn, deadline: true, unconfirmed: o.slotsOn == null };",
    to: "      return { kind: 'offFailed', slots: ours, deadline: true, unconfirmed: o.slotsOn == null }; /* MUTANT */",
    why: 'A force-charge the owner switched off from the app pages as stuck — and the record never resolves.',
  },
  {
    id: 'xxxvi. ★★ a blind escalation claims the panel still reads ON',
    file: FC,
    find: 'deadline: true, unconfirmed: o.slotsOn == null };',
    to: 'deadline: true, unconfirmed: false }; /* MUTANT */',
    why: 'With no readback at all the alarm says the panel "still reads ON" — a statement nothing measured.',
  },
  {
    id: 'xxxvii. ★★ the deadline pages every tick',
    file: FC,
    find: '  if (s.forceChargeOffDeadlinePagedAtMs == null) {\n    const deadline = forceChargeOffDeadlineMs(s);',
    to: '  if (true) { /* MUTANT */\n    const deadline = forceChargeOffDeadlineMs(s);',
    why: 'Once past the deadline every minute re-pages audibly, and the OFF is never re-sent (the page wins the tick).',
  },
  {
    id: 'xxxviii. ★★★ a panel missing from the device list skips the deadline',
    file: IDX,
    find: "    if (blind.kind === 'offFailed') await escalateForceChargeStuck(state, blind);",
    to: '    /* MUTANT */',
    why: 'A panel dropped from the list is exactly when nothing else can see a force-charge left on — the v1.167.0 early return, rebuilt.',
  },
  {
    id: 'xxxix. ★ the blind escalation speaks the "could not switch off" words',
    file: IDX,
    find: "        ? 'Critical. The night charge system could not confirm that the panel\\'s charge now setting is off. '",
    to: "        ? 'Critical. The night charge system could not switch off the panel\\'s charge now setting. ' /* MUTANT */",
    why: 'The house is told the switch-off failed when all that is known is that nothing can be read.',
  },
  {
    // v1.170.0 — REPLACES the coast-wording mutant (property retired).
    id: 'xl. ★ the announcement says an 80+ night stays on to the window close',
    file: NOTIFY,
    find: "          + `reach ~${pct(forceCeiling)}, and OFF when it gets there (or when the window closes). `",
    to: "          + `reach ~${pct(forceCeiling)}; it stays on until the window closes. ` /* MUTANT */",
    why: 'The 21:30 notice describes the retired coast.',
  },
  {
    id: 'xli. ★★★ the Thursday rule is removed',
    file: NCA,
    find: '  const costSurplusKwh: number | null = longGap ? null',
    to: '  const costSurplusKwh: number | null = false ? null /* MUTANT */',
    why: 'Thursday fills only to the solar headroom and the weekend starts short — ~$1/week the measurement found.',
  },
  {
    id: 'xlii. ★★★ the cost ceiling goes back to the P90 surplus',
    file: NCA,
    find: '      ? inputs.morningPvSurplusP50Kwh : morningPvSurplusP90Kwh);',
    to: '      ? morningPvSurplusP90Kwh : morningPvSurplusP90Kwh); /* MUTANT */',
    why: 'Every night leaves room for a best-case morning that the measured median never reached — the pack never passed 80% in 27 days.',
  },
  {
    id: 'xliii. ★★ Friday\'s 1-hour window counts as a long-gap night',
    file: NCA,
    find: '  if (!tonight || tonight.endMs - tonight.startMs < FULL_CHEAP_WINDOW_MIN_MS) return false;',
    to: '  if (!tonight) return false; /* MUTANT */',
    why: 'Friday 23:00-24:00 is sized to 90% as if it were a full night — a rule that was never measured.',
  },
  {
    id: 'xliv. ★★★ short windows are not stepped over',
    file: NCA,
    find: '    if (w.endMs - w.startMs >= FULL_CHEAP_WINDOW_MIN_MS) return w;',
    to: '    return w; /* MUTANT */',
    why: 'Friday\'s 1-hour window reads as Thursday\'s next recharge, so the Thursday rule never fires.',
  },
  {
    id: 'xlv. ★ exactly a day counts as a long gap',
    file: NCA,
    find: '  return nextFull.startMs - tonight.endMs > LONG_GAP_MS;',
    to: '  return nextFull.startMs - tonight.endMs >= LONG_GAP_MS; /* MUTANT */',
    why: 'The threshold is "more than a day"; a boundary drift re-scopes the rule silently.',
  },
  {
    id: 'xlvi. ★★★ the planner inputs drop the median and the long gap',
    file: NCA,
    find: '    morningPvSurplusP50Kwh,\n    longGapAhead,\n    buyDebiasFactor,',
    to: '    buyDebiasFactor, /* MUTANT */',
    why: 'Both are computed and never reach the sizing — the v1.125.0 field-copy trap, rebuilt.',
  },
  {
    id: 'xlvii. ★★★ index.ts computes both and never passes them',
    file: IDX,
    find: '    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead,',
    to: '    /* MUTANT */',
    why: 'The live planner keeps the P90 ceiling and no Thursday rule while every unit test passes.',
  },
  // ── v1.168.0 review fixes.
  {
    id: 'xlviii. ★★★ the deadline is keyed on the retry-budget escalation again',
    file: FC,
    find: '  if (s.forceChargeOffDeadlinePagedAtMs == null) {\n    const deadline = forceChargeOffDeadlineMs(s);',
    to: '  if (!s.forceChargeOffEscalated) { /* MUTANT */\n    const deadline = forceChargeOffDeadlineMs(s);',
    why: 'A 03:48 escalation silenced by quiet hours disarms the 06:00 page — Charge Now stays on into the on-peak with nothing ever audible.',
  },
  {
    id: 'xlix. ★★ escalated and blind, the OFF is never re-sent',
    file: FC,
    find: '      return s.forceChargeOffEscalated && since >= FORCE_CHARGE_OFF_PERSIST_EVERY_MS',
    to: '      return false && since >= FORCE_CHARGE_OFF_PERSIST_EVERY_MS /* MUTANT */',
    why: 'A stale readback plus one rejected 05:00 OFF sends exactly one OFF all day.',
  },
  {
    id: 'l. ★★ the deadline page is never recorded',
    file: IDX,
    find: '    forceChargeOffDeadlinePagedAtMs: action.deadline ? Date.now() : nightActuationMem.forceChargeOffDeadlinePagedAtMs,',
    to: '    /* MUTANT */',
    why: 'The deadline re-pages audibly on every tick once it has passed.',
  },
  {
    id: 'li. ★★ a restart forgets the deadline already paged',
    file: ACT,
    find: '    forceChargeOffDeadlinePagedAtMs: num(o.forceChargeOffDeadlinePagedAtMs),',
    to: '    forceChargeOffDeadlinePagedAtMs: null, /* MUTANT */',
    why: 'Every restart after 06:00 pages the house again for the same stuck force-charge.',
  },
  {
    // v1.170.0 — REPLACES the coast ARMED-line mutant (property retired).
    id: 'lii. ★ the ARMED line says Charge Now stays on to the window end',
    file: IDX,
    find: 'OFF when it gets there (software stop; panel ceiling ${desiredForceChargeCeilingPct(c)}% as backstop).`;',
    to: 'Charge Now stays on until the window-end OFF.`; /* MUTANT */',
    why: 'The journal describes the retired coast; an audit reads the target OFF as a surprise.',
  },
  // ── v1.169.0 — the live charge rate (grid-import cap less the house).
  {
    id: 'liii. ★★★ the rate ignores the house load',
    file: FC,
    find: '  let rate = (i.gridCapKw - Math.max(0, i.houseLoadKw)) * i.legEff;',
    to: '  let rate = i.gridCapKw * i.legEff; /* MUTANT */',
    why: 'An EV drawing 11.5 kW is invisible to the timing: the start comes hours late and the night ends far short of the target.',
  },
  {
    id: 'liv. ★★★ a house past the cap yields a rate under the floor',
    file: FC,
    find: '  return Math.max(FORCE_CHARGE_MIN_RATE_KW, rate);',
    to: '  return rate; /* MUTANT */',
    why: 'A heavy house produces a zero or negative rate — the start is pushed past the window end, or falls back to the fixed 10 kW it cannot reach.',
  },
  {
    id: 'lv. ★★★ the start ignores the live rate',
    file: FC,
    find: '  const rate = rateKw != null && Number.isFinite(rateKw)\n',
    to: '  const rate = false /* MUTANT */\n',
    why: 'The fixed 10 kW times every night — 2026-09-18 arrived at 90% at 03:30, 1.5 h early.',
  },
  {
    id: 'lvi. ★★★ index.ts computes the rate and never passes it',
    file: IDX,
    find: '    chargeRateKw,\n    evDisplacedKwh,\n  });',
    to: '    evDisplacedKwh,\n  }); /* MUTANT */',
    why: 'Every unit test passes while the live add-on keeps the fixed 10 kW.',
  },
  {
    id: 'lvii. ★★ the house load is not read from the panel',
    file: IDX,
    find: '  const houseLoadKw = shp2HouseLoadKw(sp);',
    to: '  const houseLoadKw = 0; /* MUTANT */',
    why: 'The timing assumes an empty house — an EV night starts hours late.',
  },
  // ── v1.169.0 review fixes.
  {
    id: 'lviii. ★★★ the predicted EV is not budgeted',
    file: FC,
    find: '  const evKwh = evDisplacedKwh != null && Number.isFinite(evDisplacedKwh) ? Math.max(0, evDisplacedKwh) : 0;',
    to: '  const evKwh = 0; /* MUTANT */',
    why: 'A car that plugs in after the switch-on cuts the pack ~5× and the night ends ~15 points short — bought back on-peak.',
  },
  {
    id: 'lix. ★★★ index.ts never passes the EV energy',
    file: IDX,
    find: '    evDisplacedKwh,\n  });',
    to: '  }); /* MUTANT */',
    why: 'The planner predicts the EV, the timing never hears of it.',
  },
  {
    id: 'lx. ★★ another night\'s plan supplies the EV energy',
    file: IDX,
    find: '    fcPlan?.window != null && fcPlan.window.endMs === state.windowEndMs',
    to: '    fcPlan?.window != null /* MUTANT */',
    why: 'A stale plan for a different window budgets an EV that is not coming (or misses one that is).',
  },
  {
    id: 'lxi. ★★★ the house load is not converted from W',
    file: FC,
    find: '  return any ? w / 1000 : null;',
    to: '  return any ? w : null; /* MUTANT */',
    why: 'A 2,500 W house reads as 2,500 kW: the rate floors at 1 kW and force-charge switches on at the first tick every night — the early start v1.167 removed.',
  },
  {
    id: 'lxii. ★★ a rate under the floor falls back to the faster fixed rate',
    file: FC,
    find: '    ? Math.max(FORCE_CHARGE_MIN_RATE_KW, rateKw) : FORCE_CHARGE_PLAN_RATE_KW;',
    to: '    && rateKw >= FORCE_CHARGE_MIN_RATE_KW ? rateKw : FORCE_CHARGE_PLAN_RATE_KW; /* MUTANT */',
    why: 'A near-zero known rate is swapped for 10 kW — the start comes late and the night ends short.',
  },
  {
    id: 'lxiii. ★★★ mid-window, the partial hour goes back to the LAST window hour',
    file: NCA,
    find: '  const a = Math.max(hourTs, fromMs);',
    to: '  const a = hourTs; /* MUTANT */',
    why: 'An EV predicted for the final hour counts ~1/12 of its energy at a 02:55 recompute — the start comes late and the night ends short.',
  },
  // ── v1.170.0 — the stop threshold at the start, and the per-Core rate bound.
  {
    id: 'lxiv. ★★ the start compares against the raw target, not the stop',
    file: FC,
    find: '  if (o.poolSocPct >= forceChargeStopPct(target)) return',
    to: '  if (o.poolSocPct >= target) return /* MUTANT */',
    why: 'A pack already at the panel\'s 85 ceiling for an 85.3 target is switched on anyway, then off at once — two writes for nothing.',
  },
  {
    id: 'lxv. ★★★ a Core out does not bound the rate',
    file: FC,
    find: '    rate = Math.min(rate, i.slotCount * FORCE_CHARGE_PROVEN_KW_PER_SLOT);',
    to: '    rate = rate; /* MUTANT */',
    why: 'With one Core connected the start is timed for three — the night ends far short of the target.',
  },
  {
    id: 'lxvi. ★★ index.ts never passes the connected count',
    file: IDX,
    find: '    slotCount: connectedSlots.filter((n) => n >= 1 && n <= 3).length,',
    to: '    /* MUTANT */',
    why: 'The bound exists and never runs.',
  },
  {
    id: 'xxvi. ★★ the "why not" line fires outside a live night',
    file: IDX,
    find: '    const live = state.appliedAtMs != null && state.revertedAtMs == null && !state.cancelled',
    to: '    const live = true /* MUTANT */',
    why: 'Every daytime tick against last night\'s reverted record logs a refusal — the log fills with non-decisions.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-force-charge: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
