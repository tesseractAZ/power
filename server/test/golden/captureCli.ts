/**
 * Golden capture entry point: `node --import tsx test/golden/captureCli.ts <group>` (cwd: server/),
 * with TZ=America/Phoenix. Prints the group's encoded JSON to stdout. Used by both
 * scripts/golden-capture.mts (writes the files) and test/golden.test.ts (compares against them),
 * so a capture and a check run the same code under the same environment.
 *
 * The process environment is reduced to a fixed set first: every add-on option, every tariff and
 * limit knob and every state path is unset or pinned, so a developer's shell cannot leak into a
 * golden. SITE_TIMEZONE is cleared with the rest and TZ is pinned, so the site clock
 * (startOfLocalDayMs, isOnPeakHour and its onPeakAt fallback) and the host clock the G1 table
 * records beside it (getHours) both run in America/Phoenix, the zone this install runs in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goldenJson } from './support/encode.js';

const group = process.argv[2];
if (!group) { console.error('usage: captureCli.ts <G1|G2|G3|G4|G5|G6|G7|G8>'); process.exit(2); }
if (process.env.TZ !== 'America/Phoenix') { console.error(`captureCli: TZ must be America/Phoenix (got ${process.env.TZ ?? 'unset'})`); process.exit(2); }

const KEEP = new Set(['PATH', 'HOME', 'TZ', 'TMPDIR', 'TSX_DISABLE_CACHE', 'NODE_OPTIONS', 'NODE_PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'PWD']);
for (const k of Object.keys(process.env)) if (!KEEP.has(k)) delete process.env[k];
const TMP = mkdtempSync(join(tmpdir(), 'golden-capture-'));
process.env.DB_PATH = join(TMP, 'ecoflow.db');
process.env.DATA_DIR = TMP;
process.env.BROADCAST_RUNTIME_CONFIG_PATH = join(TMP, 'broadcast-runtime-config.json');
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.BUILD_VERSION = 'golden';

try {
  const { GROUPS, redactSpares } = await import('./support/groups.js');
  const { G3 } = await import('./support/g3.js');
  const fn = group === 'G3' ? G3 : GROUPS[group];
  if (!fn) { console.error(`captureCli: unknown group ${group}`); process.exit(2); }
  const value = redactSpares(await fn());
  process.stdout.write(goldenJson({ group, value }));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}
