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
 *   Q–R   index.ts saves the baseline around the commit; index.ts never flushes
 *   S–U   the held line logs every tick; the merged count is not rendered; a failed write
 *         passes for on-disk
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
    id: 'Q. ★★★ index.ts saves the baseline directly, around the commit',
    file: IDX,
    find: '      driftHold.commit(external, nowMs, () => saveConfirmedSurface(settingsDriftState.confirmed!));',
    to: '      void external; saveConfirmedSurface(settingsDriftState.confirmed!); /* MUTANT */',
    why: 'The production tick never holds anything: the module is correct and unused.',
  },
  {
    id: 'R. ★★★ index.ts never flushes the held batch',
    file: IDX,
    find: '    void driftHold.flush(new Date()).catch(',
    to: '    void Promise.resolve().catch( /* MUTANT */',
    why: 'Changes are held forever; no push ever goes out.',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill always
// comes from the subset (the SOURCE PIN in settingsDriftHold.test.ts covers the index.ts wiring).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-20a', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false });
