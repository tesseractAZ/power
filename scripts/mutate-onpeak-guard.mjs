#!/usr/bin/env node
/**
 * mutate-onpeak-guard.mjs — R1 (v1.189.0): the night-charge write's failure paths, bounded
 * against on-peak. Every raise stops, and every restore falls due, an hour before the on-peak
 * period after the window; the force-charge OFF deadline is capped half an hour before it and
 * blind OFF re-sends stop at the next window; an unconfirmed restore pages (revertDeadline);
 * a reserve someone else set is left alone on two readings (foreign); the on-peak money
 * detectors measure past a stuck restore (heldByChargeWrite); /api/reserve-floor names the restore.
 *
 *   Stamp           S-i..S-iii
 *   On-peak guard   G-i..G-x
 *   Deadlines       D-i..D-ii
 *   revertDeadline  R-i..R-vii
 *   Foreign         F-i..F-x
 *   Money           M-i..M-vii
 *   Reserve floor   P-i..P-ii
 *
 *   node scripts/mutate-onpeak-guard.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACT = resolve(REPO, 'server/src/nightChargeActuator.ts');
const FC = resolve(REPO, 'server/src/nightForceCharge.ts');
const CW = resolve(REPO, 'server/src/chargeWindows.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const AM = resolve(REPO, 'server/src/alertMonitor.ts');
const SUBSET = [
  'test/onPeakGuard.test.ts',
  'test/nightChargeActuator.test.ts',
  'test/nightForceCharge.test.ts',
  'test/detectorHonesty.test.ts',
  'test/nightChargeWriteHoldsTheWindow.test.ts',
  'test/peakIdlePool.test.ts',
  'test/peakGridDraw.test.ts',
];

const MUTANTS = [
  /* ── the stamp ── */
  {
    id: 'S-i. ★★ an instant inside on-peak scans forward to the next period',
    file: CW,
    find: '  if (onPeak(h0)) {\n    let start = h0;',
    to: '  if (false as boolean) { /* MUTANT */\n    let start = h0;',
    why: 'A leg armed inside an on-peak period would be unguarded until the next one.',
  },
  {
    id: 'S-ii. ★★★ the arm drops the stamp',
    file: ACT,
    find: '    nextOnPeakStartMs: nextOnPeakStartMs != null && Number.isFinite(nextOnPeakStartMs) ? nextOnPeakStartMs : null,',
    to: '    nextOnPeakStartMs: null, /* MUTANT */',
    why: 'Every armed night runs the window-only schedule: no guard, no on-peak page.',
  },
  {
    id: 'S-iii. ★★★ the evening job arms with no on-peak start',
    file: IDX,
    find: '      const armOnPeakStartMs = plan.window != null ? nextOnPeakStartMs(apsREvModelFromEnv(), plan.window.startMs) : null;',
    to: '      const armOnPeakStartMs = null; /* MUTANT */',
    why: 'The guard is wired in the pure core and never reached in production.',
  },

  /* ── the on-peak guard ── */
  {
    id: 'G-i. ★★★ the apply ignores the on-peak guard',
    file: ACT,
    find: "  if (onPeakGuardActive(state, nowMs)) return { kind: 'none' }; // never a raise within an hour of on-peak",
    to: '  /* MUTANT */',
    why: 'A late window raises the reserve inside the last hour before on-peak.',
  },
  {
    id: 'G-ii. ★★★ the restore falls due at the window close only',
    file: ACT,
    find: '  const close = s.windowEndMs + REVERT_LAG_MS;\n  return guard == null ? close : Math.min(close, guard);',
    to: '  const close = s.windowEndMs + REVERT_LAG_MS;\n  return close; /* MUTANT */',
    why: 'A window running into on-peak holds the raised reserve there.',
  },
  {
    id: 'G-iii. ★★★ the write window ignores the guard (re-issues, ceiling sync, ON, OFF)',
    file: ACT,
    find: '  return guard == null ? s.windowEndMs : Math.min(s.windowEndMs, guard);',
    to: '  return s.windowEndMs; /* MUTANT */',
    why: 'Force-charge and the apply re-issues run on to the window close, into on-peak.',
  },
  {
    id: 'G-iv. ★★ the guard starts half an hour before on-peak, not an hour',
    file: ACT,
    find: 'export const ON_PEAK_RAISE_GUARD_MS = 60 * 60_000;',
    to: 'export const ON_PEAK_RAISE_GUARD_MS = 30 * 60_000; /* MUTANT */',
    why: 'The restore and OFF leave too little margin for a slow readback before on-peak.',
  },
  {
    id: 'G-v. ★★★ the apply re-issue cutoff reads the raw window close',
    file: ACT,
    find: '        const writeEnd = writeWindowEndMs(state);',
    to: '        const writeEnd = state.windowEndMs; /* MUTANT */',
    why: 'A raise is re-issued in the last hour before on-peak.',
  },
  {
    id: 'G-vi. ★★★ no force-charge OFF at the guard',
    file: FC,
    find: "  if (nowMs >= writeWindowEndMs(s)!) return 'onPeakGuard';",
    to: '  /* MUTANT */',
    why: 'Force-charge keeps buying past the guard toward on-peak.',
  },
  {
    id: 'G-vii. ★★ the OFF-first step order reads the raw window close',
    file: FC,
    find: '  return s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null\n    || s.windowEndMs == null || nowMs >= writeWindowEndMs(s)!;',
    to: '  return s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null\n    || s.windowEndMs == null || nowMs >= s.windowEndMs; /* MUTANT */',
    why: 'At the guard the OFF waits behind the reserve PUT, as before v1.187.0.',
  },
  {
    id: 'G-viii. ★★★ the force-charge start counts back from the raw window close',
    file: FC,
    find: '  const endMs = writeWindowEndMs(s)!;',
    to: '  const endMs = s.windowEndMs; /* MUTANT */',
    why: 'The ceiling sync and the ON are issued inside the guard, and the start is timed past it.',
  },
  {
    id: 'G-ix. ★★ the ON re-issue cutoff reads the raw window close',
    file: FC,
    find: '    if (s.windowEndMs == null || nowMs >= writeWindowEndMs(s)! - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) {',
    to: '    if (s.windowEndMs == null || nowMs >= s.windowEndMs - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) { /* MUTANT */',
    why: 'An ON is re-issued in front of the guard OFF, inside its cooldown.',
  },
  {
    id: 'G-x. ★★ the panel\'s ceiling is restored only after the window close',
    file: FC,
    find: '  const nightOver = s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null\n    || s.windowEndMs == null || nowMs >= writeWindowEndMs(s)!;',
    to: '  const nightOver = s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null\n    || s.windowEndMs == null || nowMs >= s.windowEndMs; /* MUTANT */',
    why: 'The synced ceiling stays on the panel into on-peak on a night whose force-charge never ran.',
  },

  /* ── deadlines ── */
  {
    id: 'D-i. ★★★ no on-peak cap on the force-charge OFF deadline',
    file: FC,
    find: '  return p != null && Number.isFinite(p) ? Math.min(later, p - ON_PEAK_PAGE_LEAD_MS) : later;',
    to: '  return later; /* MUTANT */',
    why: 'A 15:00 OFF that cannot be confirmed pages at 16:00, as on-peak starts.',
  },
  {
    id: 'D-ii. ★★ blind OFF re-sends ignore the next window\'s open',
    file: FC,
    find: '  return nextLegOpenMs != null && Number.isFinite(nextLegOpenMs) && nextLegOpenMs > s.forceChargeOffAtMs\n    ? Math.min(cap, nextLegOpenMs) : cap;',
    to: '  return cap; /* MUTANT */',
    why: 'A blind OFF from the last window switches off the next window\'s own force-charge.',
  },

  /* ── revertDeadline ── */
  {
    id: 'R-i. ★★★ a page on the owner\'s value',
    file: ACT,
    find: "  if (liveReservePct != null && liveReservePct !== s.targetPct) return { kind: 'none' };",
    to: '  /* MUTANT */',
    why: 'An owner who set the reserve themselves is woken by a critical about it.',
  },
  {
    id: 'R-ii. ★★★ a readback-dependent page (nothing on an unknown reading)',
    file: ACT,
    find: "  if (liveReservePct != null && liveReservePct !== s.targetPct) return { kind: 'none' };",
    to: "  if (liveReservePct == null || liveReservePct !== s.targetPct) return { kind: 'none' }; /* MUTANT */",
    why: 'The cloud-dark panel, the case the page exists for, never pages.',
  },
  {
    id: 'R-iii. ★★ no second page at the on-peak start',
    file: ACT,
    find: "  if (s.nextOnPeakStartMs != null && nowMs >= s.nextOnPeakStartMs && s.revertDeadlineOnPeakPagedAtMs == null) {\n    return { kind: 'page', stage: 'onPeak', unknown };\n  }",
    to: '  /* MUTANT */',
    why: 'An overnight page silenced by quiet hours is never spoken before on-peak.',
  },
  {
    id: 'R-iv. ★★★ the deadline is the window close + 30 min alone',
    file: ACT,
    find: '  return beforePeak == null ? afterClose : Math.min(afterClose, beforePeak);',
    to: '  return afterClose; /* MUTANT */',
    why: 'A window closing near on-peak pages after on-peak has started.',
  },
  {
    id: 'R-v. ★★ the deadline page repeats every tick',
    file: ACT,
    find: '  if (deadline != null && nowMs >= deadline && s.revertDeadlinePagedAtMs == null) {',
    to: '  if (deadline != null && nowMs >= deadline) { /* MUTANT */',
    why: 'A critical spoken every minute until on-peak.',
  },
  {
    id: 'R-vi. ★★ an attempted write never confirmed is not outstanding',
    file: ACT,
    find: '  return s.applyAttemptedAtMs != null && s.revertedAtMs == null;',
    to: '  return false; /* MUTANT */',
    why: 'A write whose confirmation was lost may stand raised with nothing said.',
  },
  {
    id: 'R-vii. ★★★ the tick never pages',
    file: IDX,
    find: "  if (revertPage.kind === 'page') {\n    pageRevertDeadline(state, revertPage, nowMs);",
    to: "  if (revertPage.kind === 'page' && (false as boolean)) { /* MUTANT */\n    pageRevertDeadline(state, revertPage, nowMs);",
    why: 'The pure decision is never acted on in production.',
  },

  /* ── foreign ── */
  {
    id: 'F-i. ★★★ foreign on one reading',
    file: ACT,
    find: "    return { kind: 'foreignSeen', pct };",
    to: "    return { kind: 'foreignSettled', pct }; /* MUTANT */",
    why: 'One odd reading cancels the restore and leaves the raised reserve standing.',
  },
  {
    id: 'F-ii. ★★★ foreign with no wait between the two readings',
    file: ACT,
    find: "      return nowMs - s.foreignSeenAtMs >= FOREIGN_RESERVE_SETTLE_MS ? { kind: 'foreignSettled', pct } : null;",
    to: "      return { kind: 'foreignSettled', pct }; /* MUTANT */",
    why: 'Two readings a minute apart (one readback lag) settle the night as someone else\'s.',
  },
  {
    id: 'F-iii. ★★★ foreign on a null reading',
    file: ACT,
    find: '  return inEnvelope(liveReservePct) && inEnvelope(s.priorReservePct) && s.targetPct != null',
    to: '  return (liveReservePct == null || inEnvelope(liveReservePct)) && inEnvelope(s.priorReservePct) && s.targetPct != null /* MUTANT */',
    why: 'A dark panel reads as someone else\'s reserve, and the restore is never sent.',
  },
  {
    id: 'F-iv. ★★ an out-of-envelope reading counts as foreign',
    file: ACT,
    find: '  return inEnvelope(liveReservePct) && inEnvelope(s.priorReservePct) && s.targetPct != null',
    to: '  return liveReservePct != null && inEnvelope(s.priorReservePct) && s.targetPct != null /* MUTANT */',
    why: 'A reconnect 0 stops the restore.',
  },
  {
    id: 'F-v. ★★★ a settled foreign reserve is still restored',
    file: ACT,
    find: "    if (state.foreignSettledAtMs != null) return { kind: 'none' };",
    to: '    /* MUTANT */',
    why: 'The owner\'s own reserve is overwritten at the window close.',
  },
  {
    id: 'F-vi. ★★★ a settled foreign reserve still refuses the next arm',
    file: ACT,
    // v1.189.0 — re-pointed: armFromPlan refuses on armOpenItem (one definition).
    find: '  if (prev.appliedAtMs != null && prev.revertedAtMs == null && prev.foreignSettledAtMs == null) {\n    return `the ${night} reserve write is still applied',
    to: '  if (prev.appliedAtMs != null && prev.revertedAtMs == null) { /* MUTANT */\n    return `the ${night} reserve write is still applied',
    why: 'One owner change disarms the night charge for good.',
  },
  {
    id: 'F-vii. ★★ a settled foreign reserve still reads as raised by us',
    file: ACT,
    find: '  return state.appliedAtMs != null && state.revertedAtMs == null && state.foreignSettledAtMs == null;',
    to: '  return state.appliedAtMs != null && state.revertedAtMs == null; /* MUTANT */',
    why: 'The posture and the owner floor treat the owner\'s value as the add-on\'s.',
  },
  {
    id: 'F-viii. ★★ foreign is read before the write reads back',
    file: ACT,
    find: '    const foreign = state.applyVerifiedAtMs != null ? foreignStep(state, opts.currentReservePct, nowMs) : null;',
    to: '    const foreign = foreignStep(state, opts.currentReservePct, nowMs); /* MUTANT */',
    why: 'A device that settled short (its own ceiling) is taken as someone else\'s.',
  },
  {
    id: 'F-ix. ★★★ a first foreign sighting holds the clock-driven restore',
    file: ACT,
    find: "    if (foreign?.kind === 'foreignSettled') return foreign;",
    to: '    if (foreign) return foreign; /* MUTANT */',
    why: 'The restore waits on an unconfirmed reading.',
  },
  {
    id: 'F-x. ★★ foreign does not stop the force-charge riding the write',
    file: FC,
    find: "  if (s.foreignSettledAtMs != null) return 'foreign';",
    to: '  /* MUTANT */',
    why: 'Force-charge keeps buying over a reserve the owner set.',
  },

  /* ── money detectors ── */
  {
    id: 'M-i. ★★★ the money detectors never measure past a stuck restore',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && liveReservePct === hold.targetPct && nowMs >= hold.restoreDueMs) {',
    to: '  if (hold != null && (false as boolean)) { /* MUTANT */',
    why: 'A stuck 50% reserve refilling at the peak rate reads "near the reserve" and is silent.',
  },
  {
    id: 'M-ii. ★★ the hold applies before the restore was due',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && liveReservePct === hold.targetPct && nowMs >= hold.restoreDueMs) {',
    to: '  if (hold != null && liveReservePct != null && liveReservePct === hold.targetPct) { /* MUTANT */',
    why: 'The charge window itself reads as on-peak waste.',
  },
  {
    id: 'M-iii. ★★ the hold applies to any reading',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && liveReservePct === hold.targetPct && nowMs >= hold.restoreDueMs) {',
    to: '  if (hold != null && liveReservePct != null && nowMs >= hold.restoreDueMs) { /* MUTANT */',
    why: 'An owner\'s own reserve is replaced by the night\'s prior floor.',
  },
  {
    id: 'M-iv. ★★ the hold outlives a verified restore',
    file: ACT,
    find: '  if (s.appliedAtMs == null || !revertOutstanding(s)) return null;',
    to: '  if (s.appliedAtMs == null) return null; /* MUTANT */',
    why: 'After a clean restore an owner who sets the old target is measured against the old prior.',
  },
  {
    id: 'M-v. ★★★ the grid-to-battery detector reads the live reserve',
    file: AM,
    find: '      reserveSocPct: peakReserve.reservePct,',
    to: '      reserveSocPct: peakShp2?.projection.strategy?.backupReserveSoc ?? null, /* MUTANT */',
    why: 'The hold is computed and never reaches the detector.',
  },
  {
    id: 'M-vi. ★★★ the idle-pool detector reads the live reserve',
    file: AM,
    find: '    reserveSocPct: reserve.reservePct,',
    to: '    reserveSocPct: p?.strategy?.backupReserveSoc ?? null, /* MUTANT */',
    why: 'An idle pool over a stuck 50% reserve is never reported.',
  },
  {
    id: 'M-vii. ★★ the hold is not published with the record',
    file: IDX,
    find: '  setChargeWriteHold(chargeWriteHold(s));',
    to: '  /* MUTANT */',
    why: 'The monitor sees the boot-time hold only, never a restore that stuck after boot.',
  },

  /* ── reserve floor ── */
  {
    id: 'P-i. ★★ the refusal names the window close, not the guard',
    file: ACT,
    find: '  const due = revertDueMs(s);\n  if (due == null) return { text:',
    to: '  const due = s.windowEndMs; /* MUTANT */\n  if (due == null) return { text:',
    why: 'The owner is told a restore time the actuator does not keep.',
  },
  {
    id: 'P-ii. ★ the reserve-floor 409 does not name the restore',
    file: IDX,
    find: '        error: `a night-charge write is currently holding the reserve up; ${restore.text}`,',
    to: "        error: 'a night-charge write is currently holding the reserve up; it would revert to the old floor at window close', /* MUTANT */",
    why: 'The owner cannot tell when to retry.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-onpeak-guard', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
