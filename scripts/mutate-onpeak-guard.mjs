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
 *   revertDeadline  R-i..R-xviii (each stage decided once; spans; the never-landed proof)
 *   Retry wording   T-i..T-iv
 *   Foreign         F-i..F-xv (a partly granted write's own values; the post-restore gate)
 *   Money           M-i..M-x (the restore's readback grace)
 *   Open restore    O-i..O-iii (a stuck restore refuses the next arm)
 *   Reserve floor   P-i..P-ii
 *   Fix round 2     V-i..V-v (no garbage reading decides a stage) · W-i..W-ix (a restart lets the
 *                   restore go first, bounded) · N-i..N-vii (an ACK'd write proven never to have
 *                   taken effect) · Y-i..Y-vi (the deadline page names the on-peak day)
 *   Fix round 3     B-i..B-xiii (after the restore, a partly granted night's reading within what it
 *                   asked for is the raise standing) · L-i..L-v (a write whose confirmation was lost,
 *                   read at its target across the deadline, is adopted and restored before any page)
 *   Review lows     X-i..X-ix (a dark readback's page says the restore is sent once the panel reports)
 *                   · Z-i..Z-vii (a restart just after the ACK waits for one reading, bounded)
 *                   · K-i..K-xi (the summary says "restored" only on a readback)
 *   v1.189.1       J-i..J-viii (after a restart the owed summary waits for the first reading, bounded;
 *                   the hold line does not say "only just sent" of an ACK that predates the start)
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
const TXT = resolve(REPO, 'server/src/chargeText.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const ANN = resolve(REPO, 'server/src/chargeAnnounce.ts');
const SUBSET = [
  'test/onPeakGuard.test.ts',
  'test/overnightTextGolden.test.ts',
  'test/middayAnnounce.test.ts',
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
    // v1.191.0 — re-pointed: the tariff of the plan in effect (tariffModelFromEnv).
    find: '      const armOnPeakStartMs = plan.window != null ? nextOnPeakStartMs(tariffModelFromEnv(), plan.window.startMs) : null;',
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
    find: "  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading };",
    to: '  /* MUTANT */',
    why: 'An owner who set the reserve themselves is woken by a critical about it.',
  },
  {
    id: 'R-ii. ★★★ a readback-dependent page (nothing on an unknown reading)',
    file: ACT,
    find: "  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading };",
    to: "  if (reading == null || !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading ?? -1 }; /* MUTANT */",
    why: 'The cloud-dark panel, the case the page exists for, never pages.',
  },
  {
    id: 'R-iii. ★★ no second page at the on-peak start',
    file: ACT,
    find: "    return open && nowMs < p + REVERT_PAGE_STAGE_SPAN_MS ? 'onPeak' : null;",
    to: '    return null; /* MUTANT */',
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
    find: '  const open = s.revertDeadlinePagedAtMs == null && s.revertDeadlinePassedAtMs == null;',
    to: '  const open = true; /* MUTANT */',
    why: 'A critical spoken every minute until on-peak.',
  },
  {
    id: 'R-vi. ★★ an attempted write never confirmed is not outstanding',
    file: ACT,
    find: '  return s.applyAttemptedAtMs != null && s.revertedAtMs == null && s.attemptUnlandedAtMs == null;',
    to: '  return false; /* MUTANT */',
    why: 'A write whose confirmation was lost may stand raised with nothing said.',
  },
  {
    id: 'R-vii. ★★★ the tick never pages',
    file: IDX,
    find: "  } else if (revertPage.kind === 'page') {\n    pageRevertDeadline(state, revertPage, nowMs, revertRetryPending(state, currentReservePct, shp2 != null),",
    to: "  } else if (revertPage.kind === 'page' && (false as boolean)) { /* MUTANT */\n    pageRevertDeadline(state, revertPage, nowMs, revertRetryPending(state, currentReservePct, shp2 != null),",
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
    find: '  return inEnvelope(liveReservePct) && inEnvelope(s.priorReservePct) && s.targetPct != null\n    && !isOwnReserveValue(s, liveReservePct);',
    to: '  return (liveReservePct == null || inEnvelope(liveReservePct)) && inEnvelope(s.priorReservePct) && s.targetPct != null\n    && (liveReservePct == null || !isOwnReserveValue(s, liveReservePct)); /* MUTANT */',
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
    find: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && readsOwnRaise({',
    to: '  if (hold != null && (false as boolean) && readsOwnRaise({ /* MUTANT */',
    why: 'A stuck 50% reserve refilling at the peak rate reads "near the reserve" and is silent.',
  },
  {
    id: 'M-ii. ★★ the hold applies before the restore was due',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && readsOwnRaise({',
    to: '  if (hold != null && liveReservePct != null && readsOwnRaise({ /* MUTANT */',
    why: 'The charge window itself reads as on-peak waste.',
  },
  {
    id: 'M-iii. ★★ the hold applies to any reading',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && readsOwnRaise({',
    to: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && ((_h: unknown, _v: unknown) => true)({ /* MUTANT */',
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

  /* ── revertDeadline, decided once (fix round 1) ── */
  {
    id: 'R-viii. ★★★ a deadline stage passed is paged later',
    file: ACT,
    find: '  const open = s.revertDeadlinePagedAtMs == null && s.revertDeadlinePassedAtMs == null;',
    to: '  const open = s.revertDeadlinePagedAtMs == null; /* MUTANT */',
    why: 'A restore the panel read back at 05:30 pages critical on a stale reading at 10:07.',
  },
  {
    id: 'R-ix. ★★ an on-peak stage passed is paged later',
    file: ACT,
    find: '    const open = s.revertDeadlineOnPeakPagedAtMs == null && s.revertDeadlineOnPeakPassedAtMs == null;',
    to: '    const open = s.revertDeadlineOnPeakPagedAtMs == null; /* MUTANT */',
    why: 'A stale reading at 17:00 pages a restore the panel showed restored at 16:00.',
  },
  {
    id: 'R-x. ★★★ the on-peak stage has no span',
    file: ACT,
    find: "    return open && nowMs < p + REVERT_PAGE_STAGE_SPAN_MS ? 'onPeak' : null;",
    to: "    return open ? 'onPeak' : null; /* MUTANT */",
    why: 'A record left in place pages a critical days after its on-peak period.',
  },
  {
    id: 'R-xi. ★★ the deadline stage has no span without an on-peak stamp',
    file: ACT,
    find: "  return open && nowMs < (p ?? d + REVERT_PAGE_STAGE_SPAN_MS) ? 'deadline' : null;",
    to: "  return open ? 'deadline' : null; /* MUTANT */",
    why: 'A legacy record pages on any later stale reading, for good.',
  },
  {
    id: 'R-xii. ★★★ a reading that is not ours leaves the stage undecided',
    file: ACT,
    find: "  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading };",
    to: "  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'none' }; /* MUTANT */",
    why: 'The stage is never decided on the restored value, so the next stale reading pages.',
  },
  {
    id: 'R-xiii. ★★★ the tick never stamps a passed stage',
    file: IDX,
    find: "  } else if (revertPage.kind === 'pass') {",
    to: "  } else if (revertPage.kind === 'pass' && (false as boolean)) { /* MUTANT */",
    why: 'The pure decision is made and forgotten: a later stale reading pages.',
  },
  {
    id: 'R-xiv. ★★★ the tick never stamps the never-landed proof',
    file: IDX,
    find: '  if (attemptProvedUnlanded(state, currentReservePct, nowMs)) {',
    to: '  if ((false as boolean) && attemptProvedUnlanded(state, currentReservePct, nowMs)) { /* MUTANT */',
    why: 'A write the cloud rejected all night pages critical on the first stale reading after it.',
  },
  {
    id: 'R-xv. ★★★ a proven never-landed attempt is still outstanding',
    file: ACT,
    find: '  return s.applyAttemptedAtMs != null && s.revertedAtMs == null && s.attemptUnlandedAtMs == null;',
    to: '  return s.applyAttemptedAtMs != null && s.revertedAtMs == null; /* MUTANT */',
    why: 'A rejected night pages "could not confirm the restore" at the on-peak start on a stale reading.',
  },
  {
    id: 'R-xvi. ★★ the proof is taken inside the apply window',
    file: ACT,
    find: '  const ladderOver = s.cancelled || (s.windowStartMs != null && nowMs > s.windowStartMs + APPLY_LATE_MS);',
    to: '  const ladderOver = true; /* MUTANT */',
    why: 'A retry still to come could land after the night was declared untouched.',
  },
  {
    id: 'R-xvii. ★★ the proof is taken inside the last attempt\'s readback grace',
    file: ACT,
    find: '  return ladderOver && nowMs - s.applyAttemptedAtMs >= APPLY_VERIFY_AFTER_MS;',
    to: '  return ladderOver; /* MUTANT */',
    why: 'A write that landed 40 s ago, still echoing the baseline, is declared never landed.',
  },
  {
    id: 'R-xviii. ★★★ the proof on a missing reading',
    file: ACT,
    find: '  if (s.attemptBaselinePct == null || liveReservePct == null || liveReservePct !== s.attemptBaselinePct) return false;',
    to: '  if (s.attemptBaselinePct == null || (liveReservePct != null && liveReservePct !== s.attemptBaselinePct)) return false; /* MUTANT */',
    why: 'A dark panel proves nothing, and an attempt that may stand is dropped from the pages.',
  },
  {
    id: 'R-xix. ★★ the next arm ignores the proof',
    file: ACT,
    find: '  if (s.attemptUnlandedAtMs != null) return true;',
    to: '  /* MUTANT */',
    why: 'A rejected night keeps refusing every evening whose reading is stale.',
  },

  /* ── what the page says of the restore ── */
  {
    id: 'T-i. ★★★ the page always says the restore keeps being retried',
    file: IDX,
    find: '    pageRevertDeadline(state, revertPage, nowMs, revertRetryPending(state, currentReservePct, shp2 != null),',
    to: '    pageRevertDeadline(state, revertPage, nowMs, true, /* MUTANT */',
    why: 'The owner waits for a re-send that is never coming while the panel buys on-peak.',
  },
  {
    id: 'T-ii. ★★★ spent re-issues still count as a retry',
    file: ACT,
    find: '    return readsOwnRaise(s, liveReservePct) && s.targetPct !== s.priorReservePct && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES;',
    to: '    return readsOwnRaise(s, liveReservePct); /* MUTANT */',
    why: 'The 05:30 page after revertFailed claims a retry.',
  },
  {
    id: 'T-iii. ★★★ the push text claims retries whatever it is told',
    file: ACT,
    find: "  if (retrying) return 'The add-on keeps retrying the restore.';",
    to: "  if (retrying || !retrying) return 'The add-on keeps retrying the restore.'; /* MUTANT */",
    why: 'The not-retrying page is worded as a retrying one.',
  },
  {
    id: 'T-iv. ★★ a restore the cloud has not accepted is not counted as retried',
    file: ACT,
    find: '  if (s.appliedAtMs != null && s.revertedAtMs == null) {\n    const p = s.priorReservePct;',
    to: '  if ((false as boolean) && s.appliedAtMs != null && s.revertedAtMs == null) { /* MUTANT */\n    const p = s.priorReservePct;',
    why: 'A page while the restore is re-sent every tick says nothing is re-sent.',
  },

  /* ── the foreign rule: a partly granted write's own values ── */
  {
    id: 'F-xi. ★★★ the night\'s own request read back later is foreign',
    file: ACT,
    find: '  return req != null && lower != null && req > lower && v > lower && v <= req;',
    to: '  return false; /* MUTANT */',
    why: 'The 05:00 restore is skipped and the raise stands into on-peak with no page.',
  },
  {
    id: 'F-xii. ★★★ a partly granted write the panel moved is never adopted',
    file: ACT,
    find: "    if (moved != null) return { kind: 'ceilingMoved', pct: moved };",
    to: '    /* MUTANT */',
    why: 'The deadline page and the hold compare against a value the panel no longer holds.',
  },
  {
    id: 'F-xiii. ★★★ the tick does not adopt the moved value',
    file: IDX,
    find: '    persistNightActuation({ ...state, targetPct: action.pct, foreignReservePct: null, foreignSeenAtMs: null, lastError: null });',
    to: '    persistNightActuation({ ...state, lastError: null }); /* MUTANT */',
    why: 'The adoption is decided and never recorded: the tick repeats it forever.',
  },
  {
    id: 'F-xiv. ★★ after the restore, foreign without the readback gate',
    file: ACT,
    find: '    const foreign = state.applyVerifiedAtMs == null ? null : foreignStep(state, opts.currentReservePct, nowMs);',
    to: '    const foreign = foreignStep(state, opts.currentReservePct, nowMs); /* MUTANT */',
    why: 'The panel\'s partial answer to a cancelled write settles as the owner\'s, and silences the on-peak page.',
  },
  {
    id: 'F-xv. ★★ a value within the request does not clear a pending sighting',
    file: ACT,
    find: '  if (s.foreignSeenAtMs != null && liveReservePct != null && isOwnReserveValue(s, liveReservePct)) {',
    to: '  if (s.foreignSeenAtMs != null && liveReservePct != null && (liveReservePct === s.targetPct || liveReservePct === s.priorReservePct)) { /* MUTANT */',
    why: 'A sighting of an owner value stands after the panel returned to our own write.',
  },

  /* ── the money detectors: the restore's readback grace ── */
  {
    id: 'M-viii. ★★★ the hold applies inside the restore\'s readback grace',
    file: ACT,
    find: '  return { targetPct: target, priorPct: prior, restoreDueMs: due, heldFromMs: chargeWriteHeldFromMs(due, s.revertedAtMs), ...band };',
    to: '  return { targetPct: target, priorPct: prior, restoreDueMs: due, heldFromMs: due, ...band }; /* MUTANT */',
    why: 'Almost every armed night logs a false "restore did not take" between 05:00 and the readback.',
  },
  {
    id: 'M-ix. ★★ the grace runs from the due moment, not from the restore\'s ACK',
    file: ACT,
    find: '  return Math.max(restoreDueMs, revertedAtMs) + REVERT_VERIFY_AFTER_MS;',
    to: '  return fromDue; /* MUTANT */',
    why: 'A restore accepted late is held while it is still reading back.',
  },
  {
    id: 'M-x. ★★ a late ACK lapses a hold already applied',
    file: ACT,
    find: '  if (revertedAtMs == null || revertedAtMs >= fromDue) return fromDue;',
    to: '  if (revertedAtMs == null) return fromDue; /* MUTANT */',
    why: 'The hold flaps off for five minutes after a restore that had already failed for ten.',
  },

  /* ── an unconfirmed restore holds the next arm ── */
  {
    id: 'O-i. ★★★ a stuck restore does not refuse the next arm',
    file: ACT,
    find: '  if (restoreUnconfirmed(prev, liveReservePct)) {',
    to: '  if ((false as boolean) && restoreUnconfirmed(prev, liveReservePct)) { /* MUTANT */',
    why: 'Saturday\'s arm replaces Friday\'s stuck restore: Monday\'s on-peak page and hold are lost.',
  },
  {
    id: 'O-ii. ★★ any reading keeps a sent restore open',
    file: ACT,
    find: '    && (!isReserveSetting(liveReservePct) || readsOwnRaise(s, liveReservePct));',
    to: '; /* MUTANT */',
    why: 'An owner who set the reserve to 60 in the app disarms the night charge for good.',
  },
  {
    id: 'O-iii. ★★ a restore read back still refuses the next arm',
    file: ACT,
    find: '  return s.appliedAtMs != null && s.revertedAtMs != null && revertOutstanding(s)',
    to: '  return s.appliedAtMs != null && s.revertedAtMs != null && s.foreignSettledAtMs == null /* MUTANT */',
    why: 'Every night after a restore refuses the next arm.',
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
  /* ── fix round 2: a reading that is not a reserve setting decides nothing ── */
  {
    id: 'V-i. ★★★ a reconnect 0 passes the deadline stage',
    file: ACT,
    find: '  const reading = isReserveSetting(liveReservePct) ? liveReservePct : null;',
    to: '  const reading = liveReservePct; /* MUTANT */',
    why: 'One reconnect 0 at 05:30 removes the deadline page, a second at 16:00 the on-peak page.',
  },
  {
    id: 'V-ii. ★★★ any number is a reserve setting',
    file: ACT,
    find: '  return v != null && Number.isInteger(v) && v >= RESERVE_WRITE_MIN_PCT && v <= RESERVE_WRITE_MAX_PCT;',
    to: '  return v != null; /* MUTANT */',
    why: 'A 0, a 0.5 or a 100 is read as the owner\'s reserve: the pages pass and the next arm buries the record.',
  },
  {
    id: 'V-iii. ★★★ a reconnect 0 releases the next arm',
    file: ACT,
    find: '    && (!isReserveSetting(liveReservePct) || readsOwnRaise(s, liveReservePct));',
    to: '    && (liveReservePct == null || readsOwnRaise(s, liveReservePct)); /* MUTANT */',
    why: 'A 21:30 reconnect 0 lets the next evening\'s arm replace a stuck restore\'s record.',
  },
  {
    id: 'V-iv. ★★ the arm refusal says the panel "still reads" a reconnect 0',
    file: ACT,
    find: "      : readsOwnRaise(prev, liveReservePct) ? `still reads ${liveReservePct}%` : `reads ${liveReservePct}, not a valid reserve`;",
    to: "      : `still reads ${liveReservePct}%`; /* MUTANT */",
    why: 'The evening notice tells the owner the reserve reads 0%.',
  },
  {
    id: 'V-v. ★★ a reserve setting is not read as one',
    file: ACT,
    find: '  return v != null && Number.isInteger(v) && v >= RESERVE_WRITE_MIN_PCT && v <= RESERVE_WRITE_MAX_PCT;',
    to: '  return v != null && Number.isInteger(v) && v > RESERVE_WRITE_MIN_PCT && v < RESERVE_WRITE_MAX_PCT; /* MUTANT */',
    why: 'The owner\'s 10% or the night\'s own 50% is paged as unread.',
  },

  /* ── fix round 2: a restart across the deadline lets the restore go first ── */
  {
    id: 'W-i. ★★★ the deadline pages before the restore had its chance',
    file: ACT,
    find: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage };",
    to: '  /* MUTANT */',
    why: 'A process back at 05:31 pages "could not restore" before the restore is sent, seconds before it reads back.',
  },
  {
    id: 'W-ii. ★★★ the wait has no bound',
    file: ACT,
    find: '  if (s.revertDeadlineHeldAtMs != null && nowMs - s.revertDeadlineHeldAtMs >= REVERT_DEADLINE_HOLD_MAX_MS) return false;',
    to: '  /* MUTANT */',
    why: 'A restore rate-limited or stuck unsent holds the deadline page until on-peak.',
  },
  {
    id: 'W-iii. ★★★ the deadline waits for a panel missing from the device list',
    file: ACT,
    find: '  return panelListed && due && s.revertAttempts === 0 && isReserveSetting(s.priorReservePct);',
    to: '  return due && s.revertAttempts === 0 && isReserveSetting(s.priorReservePct); /* MUTANT */',
    why: 'Nothing is sent to a panel that is not listed: its page waits ten minutes for nothing.',
  },
  {
    id: 'W-iv. ★★ the deadline waits after a rejected restore',
    file: ACT,
    find: '  return panelListed && due && s.revertAttempts === 0 && isReserveSetting(s.priorReservePct);',
    to: '  return panelListed && due && isReserveSetting(s.priorReservePct); /* MUTANT */',
    why: 'A restore the cloud refused is not paged until the wait runs out.',
  },
  {
    id: 'W-v. ★★ the deadline waits for a restore with no valid value to send',
    file: ACT,
    find: '  return panelListed && due && s.revertAttempts === 0 && isReserveSetting(s.priorReservePct);',
    to: '  return panelListed && due && s.revertAttempts === 0; /* MUTANT */',
    why: 'decideActuation sends nothing without a valid prior: the page waits for a restore that never comes.',
  },
  {
    id: 'W-vi. ★★ the readback grace never ends',
    file: ACT,
    find: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || (!readSinceBoot && !isReserveSetting(liveReservePct));',
    to: '  if (s.revertedAtMs != null) return true; /* MUTANT */',
    why: 'A 05:00 restore stuck at 50 waits ten more minutes at 05:30 before it is paged.',
  },
  {
    id: 'W-vii. ★★★ the on-peak stage waits too',
    file: ACT,
    find: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage };",
    to: "  if (restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage: 'deadline' }; /* MUTANT */",
    why: 'A process down through on-peak is paged late, while the panel buys at the peak rate.',
  },
  {
    id: 'W-viii. ★★★ the tick never says the panel is listed',
    file: IDX,
    find: '  const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, shp2 != null, nightReserveReadSinceBoot);',
    to: '  const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, false, nightReserveReadSinceBoot); /* MUTANT */',
    why: 'The wait never applies in production: the restart page goes out before the restore.',
  },
  {
    id: 'W-ix. ★★★ the tick never stamps the wait',
    file: IDX,
    find: '      persistNightActuation({ ...state, revertDeadlineHeldAtMs: nowMs });',
    to: '      /* MUTANT */',
    why: 'The bound never starts: an unsent restore holds the page until on-peak.',
  },

  /* ── fix round 2: an ACK'd write the apply ladder proved never took effect ── */
  {
    id: 'N-i. ★★★ an ACK\'d write proven never to have taken effect is still outstanding',
    file: ACT,
    find: '  if (s.appliedAtMs != null) return s.applyUnlandedAtMs == null || s.applyVerifiedAtMs != null;',
    to: '  if (s.appliedAtMs != null) return true; /* MUTANT */',
    why: 'Two critical "restore not confirmed" pages about a write the add-on itself reported never took effect.',
  },
  {
    id: 'N-ii. ★★★ the proof outranks a later landing',
    file: ACT,
    find: '  if (s.appliedAtMs != null) return s.applyUnlandedAtMs == null || s.applyVerifiedAtMs != null;',
    to: '  if (s.appliedAtMs != null) return s.applyUnlandedAtMs == null; /* MUTANT */',
    why: 'A write that landed late stands at 50% into on-peak with no page and no hold.',
  },
  {
    id: 'N-iii. ★★★ the proof before the apply ladder is over',
    file: ACT,
    find: '  if (s.appliedAtMs == null || s.applyVerifiedAtMs != null || !s.applyEscalated || s.revertedAtMs != null) return false;',
    to: '  if (s.appliedAtMs == null || s.applyVerifiedAtMs != null || s.revertedAtMs != null) return false; /* MUTANT */',
    why: 'An ACK\'d write still inside its readback lag is declared never landed.',
  },
  {
    id: 'N-iv. ★★★ the proof on a missing or other reading',
    file: ACT,
    find: '  if (liveReservePct == null || s.attemptBaselinePct == null || liveReservePct !== s.attemptBaselinePct) return false;',
    to: '  if (s.attemptBaselinePct == null) return false; /* MUTANT */',
    why: 'A dark panel, or one reading our 50%, proves the write never took effect.',
  },
  {
    id: 'N-v. ★★ the proof inside the last re-issue\'s readback grace',
    file: ACT,
    find: '  return nowMs - (s.applyLastAttemptMs ?? s.appliedAtMs) >= APPLY_VERIFY_AFTER_MS;',
    to: '  return true; /* MUTANT */',
    why: 'A re-issue that landed 40 s ago, still echoing the baseline, is declared never landed.',
  },
  {
    id: 'N-vi. ★★ the proof after the restore was sent',
    file: ACT,
    find: '  if (s.appliedAtMs == null || s.applyVerifiedAtMs != null || !s.applyEscalated || s.revertedAtMs != null) return false;',
    to: '  if (s.appliedAtMs == null || s.applyVerifiedAtMs != null || !s.applyEscalated) return false; /* MUTANT */',
    why: 'The restore reading back is taken as the write never having taken effect.',
  },
  {
    id: 'N-vii. ★★★ the tick never stamps the proof',
    file: IDX,
    find: '  if (applyProvedUnlanded(state, currentReservePct, nowMs)) {',
    to: '  if ((false as boolean) && applyProvedUnlanded(state, currentReservePct, nowMs)) { /* MUTANT */',
    why: 'The pure proof is never acted on in production.',
  },

  /* ── fix round 2: the deadline page names the on-peak day ── */
  {
    id: 'Y-i. ★★★ the tick names no day',
    file: IDX,
    find: "  const onPeakDay = d.stage === 'deadline' && state.nextOnPeakStartMs != null ? onPeakDayWords(state.nextOnPeakStartMs, nowMs) : null;",
    to: '  const onPeakDay = null; /* MUTANT */',
    why: 'A Friday window\'s 12:30 AM Saturday page says on-peak starts at 4:00 PM — that afternoon.',
  },
  {
    id: 'Y-ii. ★★★ the spoken page drops the day',
    file: ACT,
    find: "  const peakEn = o.onPeakClock != null ? `, and on-peak pricing starts ${day != null ? `${day.en} ` : ''}at ${o.onPeakClock}` : '';",
    to: "  const peakEn = o.onPeakClock != null ? `, and on-peak pricing starts at ${o.onPeakClock}` : ''; /* MUTANT */",
    why: 'The critical heard at 12:30 AM Saturday names a time that is not that day\'s.',
  },
  {
    id: 'Y-iii. ★★ the Spanish pass drops the day',
    file: ACT,
    find: "  const peakEs = o.onPeakClock != null ? `, y la tarifa punta comienza ${day != null ? `${day.es} ` : ''}a las ${o.onPeakClock}` : '';",
    to: "  const peakEs = o.onPeakClock != null ? `, y la tarifa punta comienza a las ${o.onPeakClock}` : ''; /* MUTANT */",
    why: 'The Spanish page says on-peak starts that afternoon.',
  },
  {
    id: 'Y-iv. ★★★ the push drops the day',
    file: NTF,
    find: "      : ` On-peak pricing starts ${o.onPeakDay != null ? `${o.onPeakDay.en} ` : ''}at ${o.onPeakClock}.`;",
    to: "      : ` On-peak pricing starts at ${o.onPeakClock}.`; /* MUTANT */",
    why: 'The critical push, which always goes, names Saturday afternoon for Monday\'s on-peak.',
  },
  {
    id: 'Y-v. ★★ the day is named only beyond 24 hours',
    file: TXT,
    find: '  if (phxParts(onPeakStartMs).ymd === phxParts(nowMs).ymd) return null;',
    to: '  if (onPeakStartMs - nowMs < 24 * 3_600_000) return null; /* MUTANT */',
    why: 'A page late on Sunday says "at 4:00 PM" for Monday\'s on-peak.',
  },
  {
    id: 'Y-vi. ★★★ the unconfirmed page with a day runs over the spoken bound',
    file: ACT,
    find: '    if (full.en.length + full.es.length <= MAX_SPOKEN_ADVISORY_CHARS) return full;',
    to: '    return full; /* MUTANT */',
    why: 'The bilingual critical runs past 560 characters and the broadcast clips it.',
  },
  /* ── fix round 3: after the restore, the raise of a partly granted night is still the raise ── */
  {
    id: 'B-i. ★★★ the deadline passes on the night\'s own request read back after the restore',
    file: ACT,
    find: "  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading };",
    to: "  if (reading != null && reading !== s.targetPct) return { kind: 'pass', stage, pct: reading }; /* MUTANT */",
    why: 'Asked 50, granted 40, restored, then reading 45: both pages pass and the raise stands into on-peak unsaid.',
  },
  {
    id: 'B-ii. ★★★ a stuck restore reading the raise\'s other value releases the next arm',
    file: ACT,
    find: '    && (!isReserveSetting(liveReservePct) || readsOwnRaise(s, liveReservePct));',
    to: '    && (!isReserveSetting(liveReservePct) || liveReservePct === s.targetPct); /* MUTANT */',
    why: 'The next evening\'s arm replaces the record that pages and holds for a raise still standing.',
  },
  {
    id: 'B-iii. ★★★ the readback never adopts the raise\'s other value after the restore',
    file: ACT,
    find: '    if (movedAfter != null) return { kind: \'ceilingMoved\', pct: movedAfter };',
    to: '    if ((false as boolean) && movedAfter != null) return { kind: \'ceilingMoved\', pct: movedAfter }; /* MUTANT */',
    why: 'The re-issue and its failure verdict compare against 40 while the panel holds 45: the restore is never re-sent.',
  },
  {
    id: 'B-iv. ★★ the adoption after the restore needs no verified write',
    file: ACT,
    find: '    const movedAfter = state.applyVerifiedAtMs == null ? null : ceilingMovedPct(state, opts.currentReservePct);',
    to: '    const movedAfter = ceilingMovedPct(state, opts.currentReservePct); /* MUTANT */',
    why: 'A write that never read back has its partial answer adopted as the target after the restore.',
  },
  {
    id: 'B-v. ★★★ the money detectors hold only on the exact target',
    file: ACT,
    find: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && readsOwnRaise({',
    to: '  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && liveReservePct === hold.targetPct && readsOwnRaise({ /* MUTANT */',
    why: 'The panel refilling to our 45% at the peak rate reads "near the reserve" and is silent.',
  },
  {
    id: 'B-vi. ★★★ the hold drops the band',
    file: ACT,
    find: '  const band = s.requestedPct == null ? {}',
    to: '  const band = s.requestedPct == null || (true as boolean) ? {} /* MUTANT */',
    why: 'The alert monitor\'s copy of the hold cannot tell the raise\'s other value from the owner\'s.',
  },
  {
    id: 'B-vii. ★★ the hold drops the band\'s baseline',
    file: ACT,
    find: '    : { requestedPct: s.requestedPct, ...(s.attemptBaselinePct != null ? { attemptBaselinePct: s.attemptBaselinePct } : {}) };',
    to: '    : { requestedPct: s.requestedPct }; /* MUTANT */',
    why: 'The band is measured from the prior, not from what the panel read before the write.',
  },
  {
    id: 'B-viii. ★★ the arm refusal says the raise\'s other value is not a valid reserve',
    file: ACT,
    find: "      : readsOwnRaise(prev, liveReservePct) ? `still reads ${liveReservePct}%` : `reads ${liveReservePct}, not a valid reserve`;",
    to: "      : liveReservePct === prev.targetPct ? `still reads ${liveReservePct}%` : `reads ${liveReservePct}, not a valid reserve`; /* MUTANT */",
    why: 'The evening notice calls a standing 45% reserve "not a valid reserve".',
  },
  {
    id: 'B-ix. ★★★ the page says the restore is not re-sent while it will be',
    file: ACT,
    find: '    return readsOwnRaise(s, liveReservePct) && s.targetPct !== s.priorReservePct && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES;',
    to: '    return liveReservePct === s.targetPct && s.targetPct !== s.priorReservePct && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES; /* MUTANT */',
    why: 'The 05:30 push says the add-on is not re-sending the restore on the tick before it adopts and re-sends it.',
  },
  {
    id: 'B-x. ★★★ the value we restore reads as the raise',
    file: ACT,
    find: '  return v !== s.priorReservePct && isOwnReserveValue(s, v);',
    to: '  return isOwnReserveValue(s, v); /* MUTANT */',
    why: 'The restore reading back pages "still reads 16 percent" and holds the next arm for good.',
  },
  {
    id: 'B-xi. ★★ a fraction reads as the raise',
    file: ACT,
    find: '  if (v == null || !Number.isInteger(v)) return false;\n  if (v === s.targetPct) return true;',
    to: '  if (v == null) return false; /* MUTANT */\n  if (v === s.targetPct) return true;',
    why: 'A garbage 45.5 reading holds the money detectors on the prior floor.',
  },
  {
    id: 'B-xii. ★★ the page names the target, not what the panel reads',
    file: ACT,
    find: "  if (reading != null && reading !== s.targetPct) return { kind: 'page', stage, unknown: false, readsPct: reading };",
    to: '  /* MUTANT */',
    why: 'The critical says "still reads 40 percent" while the panel reads 45.',
  },
  {
    id: 'B-xiii. ★★★ the tick pages the target, not the reading',
    file: IDX,
    find: '  const targetPct = d.readsPct ?? state.targetPct!;',
    to: '  const targetPct = state.targetPct!; /* MUTANT */',
    why: 'The pure decision carries the reading and the spoken and pushed page never use it.',
  },

  /* ── fix round 3: a lost confirmation across the deadline is adopted and restored before any page ── */
  {
    id: 'L-i. ★★★ an attempt read at its target never waits',
    file: ACT,
    find: '  if (s.appliedAtMs == null) return panelListed && attemptAdoptable(s, liveReservePct);',
    to: '  if (s.appliedAtMs == null) return false; /* MUTANT */',
    why: 'Back at 05:31 after a crash inside the write call: "could not restore … still reads 50 percent" before any restore was sent.',
  },
  {
    id: 'L-ii. ★★ an attempt waits for a panel missing from the device list',
    file: ACT,
    find: '  if (s.appliedAtMs == null) return panelListed && attemptAdoptable(s, liveReservePct);',
    to: '  if (s.appliedAtMs == null) return attemptAdoptable(s, liveReservePct); /* MUTANT */',
    why: 'Nothing is adopted or sent to a panel that is not listed: its page waits ten minutes for nothing.',
  },
  {
    id: 'L-iii. ★★★ the deadline is not told the reading',
    file: ACT,
    find: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage };",
    to: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, null, readSinceBoot)) return { kind: 'hold', stage }; /* MUTANT */",
    why: 'The wait for an attempt to be adopted never applies in production.',
  },
  {
    id: 'L-iv. ★★★ an attempt adopted on any reading',
    file: ACT,
    find: '    liveReservePct === state.targetPct &&\n    state.targetPct !== state.attemptBaselinePct &&',
    to: '    /* MUTANT */\n    state.targetPct !== state.attemptBaselinePct &&',
    why: 'A write the panel never took is adopted and restored, and a dark readback waits on it.',
  },
  {
    id: 'L-v. ★★ an attempt from its own target is adopted',
    file: ACT,
    find: '    liveReservePct === state.targetPct &&\n    state.targetPct !== state.attemptBaselinePct &&',
    to: '    liveReservePct === state.targetPct && /* MUTANT */',
    why: 'Nothing was raised: the page waits for a restore that changes nothing.',
  },

  /* ── review lows: a dark readback's page says what will happen to the restore ── */
  {
    id: 'X-i. ★★★ the tick never says what a dark restore waits on',
    file: IDX,
    find: '      revertResendOnReport(state, currentReservePct, shp2 != null));',
    to: '      null); /* MUTANT */',
    why: 'The 05:30 push says "not re-sending" for a dark readback, and the add-on then re-sends the restore.',
  },
  {
    id: 'X-ii. ★★★ an accepted restore\'s re-send on a reading is not said',
    file: ACT,
    find: "      && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES ? 'raise' : null;",
    to: "      && !s.revertReadbackEscalated && s.revertRetries < 0 ? 'raise' : null; /* MUTANT */",
    why: 'The page says nothing more is tried while one or two re-issues wait on the next readback.',
  },
  {
    id: 'X-iii. ★★ spent re-issues still wait on a reading',
    file: ACT,
    find: "      && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES ? 'raise' : null;",
    to: "      && !s.revertReadbackEscalated ? 'raise' : null; /* MUTANT */",
    why: 'After revertFailed the page promises a re-send that never comes.',
  },
  {
    id: 'X-iv. ★★ a restore never accepted, the panel unlisted, is not said to follow',
    file: ACT,
    find: "  if (s.appliedAtMs != null && s.revertedAtMs == null) return isReserveSetting(s.priorReservePct) ? 'listed' : null;",
    to: "  if (s.appliedAtMs != null && s.revertedAtMs == null) return null; /* MUTANT */",
    why: 'The page says "not re-sending", and the restore goes on the first tick the panel is listed.',
  },
  {
    id: 'X-v. ★★★ a known reading waits on a report',
    file: ACT,
    find: '  if (isReserveSetting(liveReservePct) || revertRetryPending(s, liveReservePct, panelListed)) return null;',
    to: '  if (revertRetryPending(s, liveReservePct, panelListed)) return null; /* MUTANT */',
    why: 'A panel that reads the restore is said to be awaited.',
  },
  {
    id: 'X-vi. ★★★ the push drops the wait',
    file: NTF,
    find: '      + `Set the backup reserve to ${to} in the EcoFlow app. ${revertRetryText(o.retrying, o.resendOnReport ?? null)}`,',
    to: '      + `Set the backup reserve to ${to} in the EcoFlow app. ${revertRetryText(o.retrying)}`, /* MUTANT */',
    why: 'The overnight push still says "not re-sending" for a restore that will be re-sent.',
  },
  {
    id: 'X-vii. ★★ the mid-day push drops the wait',
    file: TXT,
    find: "o.forceChargeOffOpen ? ' and switch Charge Now off' : ''} in the EcoFlow app. ${revertRetryText(o.retrying, o.resendOnReport ?? null)}`,",
    to: "o.forceChargeOffOpen ? ' and switch Charge Now off' : ''} in the EcoFlow app. ${revertRetryText(o.retrying)}`, /* MUTANT */",
    why: 'The mid-day page says what the overnight page no longer does.',
  },
  {
    id: 'X-viii. ★★ the words for a re-send on a reading are the not-re-sending words',
    file: ACT,
    find: "  if (onReport === 'raise') return 'The add-on sends the restore if the panel still reads the raised reserve once it reports again.';",
    to: "  if ((false as boolean) && onReport === 'raise') return 'The add-on sends the restore if the panel still reads the raised reserve once it reports again.'; /* MUTANT */",
    why: 'The decision is right and the push still says the opposite.',
  },
  {
    id: 'X-ix. ★★ the mid-day page is not told the wait',
    file: ANN,
    find: '    resendOnReport: o.resendOnReport ?? null,',
    to: '    resendOnReport: null, /* MUTANT */',
    why: 'The mid-day leg says "not re-sending" where the overnight leg says what follows.',
  },

  /* ── review lows: a restart just after the ACK waits for one reading ── */
  {
    id: 'Z-i. ★★★ the restart wait never applies',
    file: ACT,
    find: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || (!readSinceBoot && !isReserveSetting(liveReservePct));',
    to: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS; /* MUTANT */',
    why: 'Back at 05:40 with the readback not yet fresh: an immediate false critical, a tick before the restore reads back.',
  },
  {
    id: 'Z-ii. ★★★ the wait after a start ignores the reading',
    file: ACT,
    find: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || (!readSinceBoot && !isReserveSetting(liveReservePct));',
    to: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || !readSinceBoot; /* MUTANT */',
    why: 'A first reading of the raise after a start waits ten minutes before it is paged.',
  },
  {
    id: 'Z-iii. ★★★ every dark readback waits, restart or not',
    file: ACT,
    find: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || (!readSinceBoot && !isReserveSetting(liveReservePct));',
    to: '  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || !isReserveSetting(liveReservePct); /* MUTANT */',
    why: 'A process up all night delays the 05:30 page of a dark readback by ten minutes.',
  },
  {
    id: 'Z-iv. ★★★ the deadline is not told whether the process has read the reserve',
    file: ACT,
    find: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage };",
    to: "  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading)) return { kind: 'hold', stage }; /* MUTANT */",
    why: 'The wait is defined and never reached.',
  },
  {
    id: 'Z-v. ★★★ the tick never passes the flag',
    file: IDX,
    find: '  const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, shp2 != null, nightReserveReadSinceBoot);',
    to: '  const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, shp2 != null); /* MUTANT */',
    why: 'The wait never applies in production.',
  },
  {
    id: 'Z-vi. ★★★ the tick never sets the flag',
    file: IDX,
    find: '  if (isReserveSetting(currentReservePct)) nightReserveReadSinceBoot = true;',
    to: '  /* MUTANT */',
    why: 'Every dark readback waits ten minutes before its page, all night, every night.',
  },
  {
    id: 'Z-vii. ★★ the flag starts set',
    file: IDX,
    find: 'let nightReserveReadSinceBoot = false;',
    to: 'let nightReserveReadSinceBoot = true; /* MUTANT */',
    why: 'A start is never seen: the false critical after a restart is back.',
  },

  /* ── review lows: the summary says "restored" only on a readback ── */
  {
    id: 'K-i. ★★★ the summary is owed on the ACK',
    file: ACT,
    find: "  return nowMs - s.revertedAtMs >= REVERT_VERIFY_AFTER_MS ? 'acknowledged' : null;",
    to: "  return 'acknowledged'; /* MUTANT */",
    why: 'Every morning reads "sent, not yet confirmed" about a restore that reads back a minute later.',
  },
  {
    id: 'K-ii. ★★★ a summary with no readback says restored',
    file: ACT,
    find: "  return nowMs - s.revertedAtMs >= REVERT_VERIFY_AFTER_MS ? 'acknowledged' : null;",
    to: "  return nowMs - s.revertedAtMs >= REVERT_VERIFY_AFTER_MS ? 'readBack' : null; /* MUTANT */",
    why: '"Reserve restored" at 05:05, and "reserve restore not confirmed" (critical) at 05:30.',
  },
  {
    id: 'K-iii. ★★★ the summary goes again',
    file: ACT,
    find: '  if (s.day == null || s.revertedAtMs == null || s.restoreSummaryAtMs != null) return null;',
    to: '  if (s.day == null || s.revertedAtMs == null) return null; /* MUTANT */',
    why: 'A summary every minute from 05:05 until the next night arms.',
  },
  {
    id: 'K-iv. ★★★ an update sends the last night\'s summary again',
    file: ACT,
    find: '    restoreSummaryAtMs: o.restoreSummaryAtMs === undefined ? num(o.revertedAtMs) : num(o.restoreSummaryAtMs),',
    to: '    restoreSummaryAtMs: num(o.restoreSummaryAtMs), /* MUTANT */',
    why: 'Installing the release in the afternoon pushes the morning summary a second time.',
  },
  {
    id: 'K-iv-b. ★★ a reading of the restore is summarised as not read back',
    file: ACT,
    find: '  if (liveReservePct != null && liveReservePct === s.priorReservePct) return null;',
    to: '  /* MUTANT */',
    why: '"Not read back yet" on the very tick the panel reports the restored reserve.',
  },
  {
    id: 'K-iv-c. ★★ the tick does not tell the summary the reading',
    file: IDX,
    find: '  const summaryOwed = restoreSummaryDue(state, nowMs, currentReservePct, nightReserveReadSinceBoot);',
    to: '  const summaryOwed = restoreSummaryDue(state, nowMs, null, nightReserveReadSinceBoot); /* MUTANT */',
    why: 'The rule is defined and never reached.',
  },
  {
    id: 'K-v. ★★★ the tick never sends the owed summary',
    file: IDX,
    find: '  } else if (summaryOwed != null) {\n    sendRestoreSummary(state, summaryOwed, nowMs);',
    to: '  } else if (summaryOwed != null && (false as boolean)) { /* MUTANT */\n    sendRestoreSummary(state, summaryOwed, nowMs);',
    why: 'A restore that does not read back gets no summary at all.',
  },
  /* ── v1.189.1: after a restart, the owed summary waits for this process's first reading ── */
  {
    id: 'J-i. ★★★ the summary never waits for the first reading',
    file: ACT,
    find: "  if (restoreSummaryAwaitsFirstReading(s, nowMs, liveReservePct, readSinceBoot)) return 'hold';",
    to: '  /* MUTANT */',
    why: 'A restart across the readback grace sends "the restore was sent and has not read back" on its first tick, and the readback a tick later adds a "restored" card after it.',
  },
  {
    id: 'J-ii. ★★★ the wait is unbounded',
    file: ACT,
    find: '  return s.restoreSummaryHeldAtMs == null || nowMs - s.restoreSummaryHeldAtMs < REVERT_DEADLINE_HOLD_MAX_MS;',
    to: '  return true; /* MUTANT */',
    why: 'A panel that never reports again after a restart leaves the night with no summary at all.',
  },
  {
    id: 'J-iii. ★★★ the wait ignores a reading of the raise',
    file: ACT,
    find: '  if (readSinceBoot || isReserveSetting(liveReservePct)) return false;',
    to: '  if (readSinceBoot) return false; /* MUTANT */',
    why: 'The first reading shows the raise standing, and the summary still waits instead of saying the restore was sent.',
  },
  {
    id: 'J-iv. ★★★ every dark tick waits, restart or not',
    file: ACT,
    find: '  if (readSinceBoot || isReserveSetting(liveReservePct)) return false;',
    to: '  if (isReserveSetting(liveReservePct)) return false; /* MUTANT */',
    why: 'A panel dark through the readback grace delays every morning summary ten minutes, with no restart.',
  },
  {
    id: 'J-v. ★★★ the tick does not tell the summary whether the reserve has been read since the start',
    file: IDX,
    find: '  const summaryOwed = restoreSummaryDue(state, nowMs, currentReservePct, nightReserveReadSinceBoot);',
    to: '  const summaryOwed = restoreSummaryDue(state, nowMs, currentReservePct, true); /* MUTANT */',
    why: 'The pure rule waits; the tick never asks it to.',
  },
  {
    id: 'J-vi. ★★★ the tick never stamps the wait',
    file: IDX,
    find: '      persistNightActuation({ ...state, restoreSummaryHeldAtMs: nowMs });',
    to: '      /* MUTANT */',
    why: 'With no stamp the bound never starts: a panel that stays dark after a restart leaves the night with no summary.',
  },
  {
    id: 'J-vii. ★★ the stamp does not survive a restart',
    file: ACT,
    find: '    restoreSummaryHeldAtMs: num(o.restoreSummaryHeldAtMs),',
    to: '    restoreSummaryHeldAtMs: null, /* MUTANT */',
    why: 'A restart loop inside the wait starts the ten minutes over each time.',
  },
  {
    id: 'J-viii. ★★ the hold line says "only just sent" of a restore sent before the restart',
    file: ACT,
    find: "  if (revertedAtMs < bootMs) return 'sent before the add-on last started';",
    to: '  /* MUTANT */',
    why: 'The log claims a restore acknowledged before the restart was only just sent.',
  },
  {
    id: 'K-vi. ★★★ the readback tick does not send it',
    file: IDX,
    find: '    if (owed != null) sendRestoreSummary(nightActuationMem, owed, nowMs);',
    to: '    /* MUTANT */',
    why: 'The "restored" summary waits a tick, past the hand-over to the next leg of a two-leg cycle.',
  },
  {
    id: 'K-vii. ★★★ the overnight summary says restored with no readback',
    file: NTF,
    find: "  const acked = o.restore === 'acknowledged';\n  const sent = ",
    to: "  const acked = false; /* MUTANT */\n  const sent = ",
    why: 'The words before: "restored" on a restore that has not read back.',
  },
  {
    id: 'K-viii. ★★ the mid-day summary says restored with no readback',
    file: TXT,
    find: "  const acked = o.restore === 'acknowledged';\n  const ackedText = ",
    to: "  const acked = false; /* MUTANT */\n  const ackedText = ",
    why: 'The mid-day leg says what the overnight leg no longer does.',
  },
  {
    id: 'K-ix. ★★ the mid-day summary is not told the readback',
    file: ANN,
    find: "    restore: o.restore ?? 'readBack',",
    to: "    restore: 'readBack', /* MUTANT */",
    why: 'Every mid-day summary says restored.',
  },
  {
    id: 'K-x. ★★★ the summary is not stamped before it is sent',
    file: IDX,
    find: '  persistNightActuation({ ...state, restoreSummaryAtMs: nowMs });',
    to: '  /* MUTANT */',
    why: 'The summary goes on every tick, and again after every restart.',
  },
  {
    id: 'K-xi. ★★ the grid-loss abort is not kept with the restore',
    file: IDX,
    find: '    persistNightActuation({ ...state, revertedAtMs: nowMs, lastError: null, revertGridLossAbort: action.gridLossAbort === true });',
    to: '    persistNightActuation({ ...state, revertedAtMs: nowMs, lastError: null }); /* MUTANT */',
    why: 'A night the grid loss stopped is summarised as completed, with its full expected figure.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-onpeak-guard', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
