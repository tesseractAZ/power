/**
 * Shared atomic-persist helper for the alarm-state sidecars (notify-state,
 * battery-soc-alarm, runway-alarm, lighting-posture). One implementation so
 * the idiom can't drift between sites.
 *
 * Hardened for CodeQL js/insecure-temporary-file while preserving the
 * ALARM-CRITICAL semantics of the inline idiom it replaced:
 *
 *   - The temp file lives in the SAME DIRECTORY as the target. rename(2) is
 *     atomic only within one filesystem — a cross-device temp (e.g. under
 *     os.tmpdir) would EXDEV-fail the rename and could leave corrupt alarm
 *     state across this host's frequent reboots. Do NOT "fix" this to a
 *     shared temp dir.
 *   - Full write THEN rename: a reader (or a crash mid-write) never observes
 *     a partial file at the target path.
 *   - The temp name is unpredictable (pid + 6 random bytes) and created
 *     exclusively (`wx`, mode 0600), so a pre-planted file or symlink at a
 *     guessable `<path>.tmp` can neither be followed nor clobbered. The
 *     0600 mode carries over to the renamed target — these sidecars are
 *     read only by this process.
 *   - On ANY failure after the temp may exist, it is best-effort removed so
 *     orphaned temps don't accumulate in /data.
 *
 * THROWS on failure (after cleaning up the temp). Callers keep their
 * existing swallow-and-continue posture — these are best-effort persists
 * and a failed persist must NEVER throw into the alarm loop.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Unpredictable same-directory temp name for `path`. Exported for tests. */
export function atomicTempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Matches temps produced by atomicTempPath for `base` — ONLY that exact shape
 * (`<base>.<pid>.<12 hex>.tmp`), never sibling files that merely share the
 * prefix. Exported for tests.
 */
export function isAtomicTempFor(base: string, name: string): boolean {
  if (!name.startsWith(`${base}.`)) return false;
  return /\.\d+\.[0-9a-f]{12}\.tmp$/.test(name.slice(base.length));
}

/**
 * v0.79.0 — remove crash-orphaned temps for `path`. Random temp names mean a
 * hard crash (power cut — this host's dominant reboot cause) between write and
 * rename leaves a uniquely-named orphan that nothing else reclaims (the old
 * fixed `<path>.tmp` name self-healed by overwrite). Called after each
 * successful save: these saves are SYNCHRONOUS on the single main thread, so
 * no in-flight temp for the same target can exist at that moment — every
 * match is a dead orphan. Best-effort; never throws.
 */
function sweepOrphanTemps(path: string): void {
  try {
    const dir = dirname(path);
    const base = basename(path);
    for (const name of readdirSync(dir)) {
      if (isAtomicTempFor(base, name)) rmSync(join(dir, name), { force: true });
    }
  } catch { /* best effort — an unreadable dir just skips the sweep */ }
}

/** Atomically replace `path` with `data` (write temp → rename). Throws on failure. */
export function atomicWriteFileSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = atomicTempPath(path);
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  sweepOrphanTemps(path);
}
