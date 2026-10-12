#!/usr/bin/env node
/**
 * mutate-v1187-20a.mjs — v1.187.20: a settings-drift push held for the notify quiet window
 * survives a restart (server/src/settingsDriftHold.ts).
 *
 *   A–C   the three the defect is made of: the held set is not persisted, not rehydrated, or
 *         cleared before the push succeeds
 *   D–E   the baseline that hides a change reaches disk before (or without) the change itself
 *   F–G   merging: repeated changes of a key append instead of collapsing; a re-confirmed
 *         movement counts as a second change
 *   H–J   boot and bounds: a corrupt sidecar throws into boot; expiry and the cap are gone
 *   K–N   delivery: two sends in flight (no guard, no deadline, or a stale release); a mid-send
 *         change is lost; quiet hours ignored; the sidecar is not rewritten after the push, so a
 *         restart sends it again
 *   O–P   the reserve-floor dedupId is lost; the sidecar leaves the baseline's directory
 *   Q–R   index.ts never hands the tick to settleDriftTick, or hands it only a tick that
 *         confirmed a change; R3 replaces the classifier's context with a stand-in
 *   S–U   the held line logs every tick; the merged count is not rendered; a failed write
 *         passes for on-disk
 *
 *   Round 2 (the adversarial review of 98bb3f1 — each of these SURVIVED it):
 *   V1–V3 the post-evaluate step (settleDriftTick): the flush runs only on a tick that confirmed
 *         a change (the 10-10 loss again); an external change is never held; the own-write
 *         classification is skipped
 *   W     the commit is skipped when nothing is external: an own write's baseline never saves
 *   X1–X7 a deferred baseline save: recovery never noticed; never retried; a failed sidecar write
 *         not retried; saved while the change is memory-only; dropped when the save throws;
 *         the two failure lines logged on every retry
 *   Y1–Y2 expiry: a merge does not refresh the age; no expiry at flush time
 *   AA    the adoption tick does not save the first baseline
 *
 *   node scripts/mutate-v1187-20a.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOLD = resolve(REPO, 'server/src/settingsDriftHold.ts');
const DRIFT = resolve(REPO, 'server/src/settingsDrift.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = ['test/settingsDriftHold.test.ts', 'test/settingsDrift.test.ts'];

const MUTANTS = [
  {
    id: 'A. ★★★ the held set is never persisted (the defect)',
    file: HOLD,
    find: '    return this.persist();',
    to: '    return true; /* MUTANT */',
    why: 'The held change lives in memory only; the 23:25 restart loses it again.',
  },
  {
    id: 'B. ★★★ the sidecar is never rehydrated at construction (the defect)',
    file: HOLD,
    find: '    this.entries = this.rehydrate();',
    to: '    this.entries = []; /* MUTANT */',
    why: 'The change is on disk but the next boot starts empty; 06:00 finds nothing to push.',
  },
  {
    id: 'C. ★★★ the held set is cleared before the push succeeds',
    file: HOLD,
    find: '      this.flight = flight;',
    to: '      this.flight = flight; this.entries = []; this.persist(); /* MUTANT */',
    why: 'A failed push (HA down at 06:00) loses the change on disk and in memory.',
  },
  {
    id: 'D. ★★★ the baseline is saved BEFORE the held change reaches disk',
    file: HOLD,
    find: '  commit(external: SettingChange[], nowMs: number, saveBaseline: () => void): boolean {',
    to: '  commit(external: SettingChange[], nowMs: number, saveBaseline: () => void): boolean {\n    saveBaseline(); /* MUTANT */',
    why: 'A crash between the two writes leaves a baseline that hides a change nothing holds.',
  },
  {
    id: 'E. ★★ the baseline is saved even when the held change could not be written',
    file: HOLD,
    find: '    if (!this.hold(external, nowMs)) {',
    to: '    if (!this.hold(external, nowMs) && false) { /* MUTANT */',
    why: 'A disk error plus a restart loses the change: the baseline already holds the new value.',
  },
  {
    id: 'F. ★★ repeated changes of a key append instead of collapsing',
    file: HOLD,
    find: '      if (e == null) {',
    to: '      if (true) { /* MUTANT */',
    why: 'A flapping setting grows the sidecar without bound and the push lists every flap.',
  },
  {
    id: 'G. ★ the same movement re-confirmed counts as a second change',
    file: HOLD,
    find: '      } else if (e.to !== c.to) {',
    to: '      } else if (true) { /* MUTANT */',
    why: 'A restart between the sidecar write and the baseline save reports "2 changes" for one.',
  },
  {
    id: 'H. ★★★ a corrupt sidecar throws into boot',
    file: HOLD,
    find: '      raw = JSON.parse(text);\n    } catch (e: any) {',
    to: '      raw = JSON.parse(text);\n    } catch (e: any) { throw e; /* MUTANT */',
    why: 'A torn or hand-edited sidecar crashes the add-on at module load.',
  },
  {
    id: 'I. ★ very old held changes are never expired',
    file: HOLD,
    find: '    const stale = this.entries.filter((e) => nowMs - e.lastAtMs > this.maxAgeMs);',
    to: '    const stale: HeldDriftChange[] = []; /* MUTANT */',
    why: 'A change that could not be pushed for weeks is still pushed as news.',
  },
  {
    id: 'J. ★ the entry cap is gone',
    file: HOLD,
    find: '    if (this.entries.length > this.maxEntries) {',
    to: '    if (false) { /* MUTANT */',
    why: 'An unbounded key set (labels changing) grows the sidecar without limit.',
  },
  {
    id: 'K. ★★ two sends in flight at once',
    file: HOLD,
    find: '      if (this.flight != null) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A slow push and the next tick both send the same batch.',
  },
  {
    id: 'K2. ★★ a hung send blocks every later push (no deadline)',
    file: HOLD,
    find: "        if (now.getTime() - this.flight.sinceMs < this.sendDeadlineMs) return 'in-flight';",
    to: "        return 'in-flight'; /* MUTANT */",
    why: 'One request that never resolves silences the drift push until the next restart.',
  },
  {
    id: 'K3. ★ a late resolution of a given-up send releases the guard of the newer one',
    file: HOLD,
    find: '        if (this.flight === flight) this.flight = null;',
    to: '        this.flight = null; /* MUTANT */',
    why: 'The hung send finishing late lets a third send race the second.',
  },
  {
    id: 'L. ★★ a change that arrives mid-send is dropped when the send resolves',
    file: HOLD,
    find: '      if (e.to === s.to && e.changes === s.changes) {',
    to: '      if (true) { /* MUTANT */',
    why: 'Readiness vs value across the await: the unannounced 2 → 1 vanishes with the 0 → 2 push.',
  },
  {
    id: 'M. ★★ quiet hours are ignored',
    file: HOLD,
    find: '      if (this.isQuiet(now)) {',
    to: '      if (false) { /* MUTANT */',
    why: 'The 23:01 change pushes at 23:01 instead of being held for 06:00.',
  },
  {
    id: 'N. ★★ the sidecar is not rewritten after a successful push',
    file: HOLD,
    find: '    this.version++;\n    this.persist();\n  }\n\n  /** Drop entries',
    to: '    this.version++; /* MUTANT */\n  }\n\n  /** Drop entries',
    why: 'Every later restart re-sends a push the operator already had.',
  },
  {
    id: 'O. ★★ a held reserve-floor change loses its own dedupId',
    file: HOLD,
    find: '  const floor = batch.find((c) => c.key.endsWith(RESERVE_FLOOR_SUFFIX));',
    to: '  const floor = batch.find(() => false); /* MUTANT */',
    why: 'v1.119.0 regresses: a Storm Guard floor raise is coalesced behind ordinary drift.',
  },
  {
    id: 'P. ★ the sidecar leaves the baseline\'s directory',
    file: HOLD,
    find: "join(dirname(settingsSurfacePath()), 'settings-drift-held.json')",
    to: "join(process.cwd(), 'settings-drift-held.json') /* MUTANT */",
    why: 'Off /data the sidecar does not survive an add-on update, and the atomic rename may cross filesystems.',
  },
  {
    id: 'Q. ★★★ index.ts never hands the tick to settleDriftTick',
    file: IDX,
    find: '    void settleDriftTick({',
    to: '    void Promise.resolve({ /* MUTANT */',
    why: 'The production tick neither holds nor pushes anything: the module is correct and unused.',
  },
  {
    id: 'R. ★★★ index.ts hands settleDriftTick only a tick that confirmed a change (review finding 1)',
    file: IDX,
    find: '    void settleDriftTick({',
    to: '    if (evaln.confirmedChanges.length > 0) void settleDriftTick({ /* MUTANT */',
    why: 'The 06:00 tick confirms nothing, so the change held at 23:02 is never pushed: the 10-10 loss.',
  },
  {
    id: 'R3. ★★ index.ts classifies with a stand-in context',
    file: IDX,
    find: '      context: driftActuatorContext,',
    to: '      context: () => ({ targetPct: null, priorReservePct: null, nightActive: false }), /* MUTANT */',
    why: 'Every own write (the owner floor, the night reserve, our force-charge) is pushed as external.',
  },
  {
    id: 'S. the held line logs on every quiet tick',
    file: HOLD,
    find: '        if (this.heldLoggedVersion !== this.version) {',
    to: '        if (true) { /* MUTANT */',
    why: 'A held change writes a log line every minute for eight hours.',
  },
  {
    id: 'T. ★ the merged count is not rendered in the push',
    file: DRIFT,
    find: "  if (c.changes == null || c.changes <= 1) return '';",
    to: "  return ''; /* MUTANT */",
    why: 'A setting that flapped overnight reads like a single change.',
  },
  {
    id: 'U. ★★ a failed sidecar write passes for on-disk',
    file: HOLD,
    find: '      this.onDisk = false;',
    to: '      this.onDisk = true; /* MUTANT */',
    why: 'The commit saves the baseline although the change it hides is in memory only.',
  },

  /* ── round 2: the review's surviving mutants, now killed behaviourally ── */
  {
    id: 'V1. ★★★ the flush runs only on a tick that confirmed a change (review finding 1)',
    file: HOLD,
    find: '  return queue.flush(now);',
    to: "  return evaluation.confirmedChanges.length > 0 ? queue.flush(now) : 'empty'; /* MUTANT */",
    why: 'The 23:02 change is held, the 06:00 tick confirms nothing, and no push ever goes out.',
  },
  {
    id: 'V2. ★★★ an external change is never held (review finding 2)',
    file: HOLD,
    find: '          external.push(c);',
    to: '          void c; /* MUTANT */',
    why: 'The EXTERNAL line is logged, commit([]) saves the baseline, and the change is invisible for good.',
  },
  {
    id: 'V3. ★★ the own-write classification is skipped',
    file: HOLD,
    find: '        const kind = classifyChange(c, ctx);',
    to: "        const kind = 'external' as string; /* MUTANT */",
    why: "The owner's own floor write and our force-charge are pushed as third-party changes.",
  },
  {
    id: 'W. ★★★ the commit is skipped when nothing is external (review finding 3)',
    file: HOLD,
    find: '      queue.commit(external, nowMs, saveBaseline);',
    to: '      if (external.length > 0) queue.commit(external, nowMs, saveBaseline); /* MUTANT */',
    why: "An own-write tick never saves the baseline; after a restart the owner's floor write is pushed as external.",
  },
  {
    id: 'X1. ★★ a sidecar write that succeeds again is never noticed (review finding 4)',
    file: HOLD,
    find: '      this.onDisk = true;\n      if (!wasOnDisk)',
    to: '      /* MUTANT */\n      if (!wasOnDisk)',
    why: 'Every later baseline save is refused for the life of the process; a restart pushes the change again.',
  },
  {
    id: 'X2. ★★★ a deferred baseline save is never retried (review finding 4)',
    file: HOLD,
    find: '      if (this.pendingBaseline != null && this.onDisk && this.runPendingBaseline()) {',
    to: '      if (false) { /* MUTANT */',
    why: 'The old baseline stays on disk after the push goes out; the next restart pushes it a second time.',
  },
  {
    id: 'X3. ★★ a failed sidecar write is retried only at the next confirmed change',
    file: HOLD,
    find: '      if (bounded || !this.onDisk) this.persist();',
    to: '      if (bounded) this.persist(); /* MUTANT */',
    why: 'The held change stays memory-only after the disk recovers, and a cleared batch stays on disk to be re-sent.',
  },
  {
    id: 'X4. ★★★ the deferred baseline is saved while the held change is memory-only',
    file: HOLD,
    find: '      if (this.pendingBaseline != null && this.onDisk && this.runPendingBaseline()) {',
    to: '      if (this.pendingBaseline != null && this.runPendingBaseline()) { /* MUTANT */',
    why: 'The retry defeats the commit order: a restart finds a baseline hiding a change nothing holds.',
  },
  {
    id: 'X5. ★★ a baseline save that throws is dropped, not kept pending',
    file: HOLD,
    find: '      this.baselineFailing = true;\n      return false;',
    to: '      this.baselineFailing = true; this.pendingBaseline = null; /* MUTANT */\n      return false;',
    why: 'One ENOSPC leaves the old baseline on disk; the next restart pushes the change again.',
  },
  {
    id: 'X6. a failing baseline save is logged on every retry',
    file: HOLD,
    find: '      if (!this.baselineFailing) this.log.warn(',
    to: '      if (true) this.log.warn( /* MUTANT */',
    why: 'A full disk writes a warning every minute and pushes the incident out of the log ring.',
  },
  {
    id: 'X7. a failing sidecar write is logged on every retry',
    file: HOLD,
    find: '      if (wasOnDisk) {',
    to: '      if (true) { /* MUTANT */',
    why: 'The same, for the sidecar: one line per tick for as long as the disk is down.',
  },
  {
    id: 'Y1. ★ a merge no longer refreshes the age (review finding 5)',
    file: HOLD,
    find: '        e.lastAtMs = nowMs;\n',
    to: '        /* MUTANT */\n',
    why: 'A change made two days ago is dropped as "never pushed in 168 h" because the key first moved 8 days ago.',
  },
  {
    id: 'Y2. ★ no expiry at flush time (review finding 5)',
    file: HOLD,
    find: '      const bounded = this.enforceBounds(now.getTime());',
    to: '      const bounded = false; /* MUTANT */',
    why: 'In a process that never restarts, a week-stale change is pushed as news when the channel recovers.',
  },
  {
    id: 'AA. ★ the adoption tick does not save the first baseline',
    file: HOLD,
    find: '    saveBaseline();\n    log.info(`settings-drift: baseline adopted',
    to: '    /* MUTANT */\n    log.info(`settings-drift: baseline adopted',
    why: 'Until the first confirmed change nothing is on disk, and a restart silently re-adopts whatever is there.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill always
// comes from the subset. The tick's behaviour is driven through settleDriftTick, the function
// index.ts calls; the SOURCE PIN in settingsDriftHold.test.ts pins index.ts's whole (short) tick
// text, so a guard around the call or a stand-in context (Q, R, R3) changes it.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-20a', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false });
