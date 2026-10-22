#!/usr/bin/env -S node --import tsx
/**
 * golden-capture.mts — (re)capture the characterisation goldens in server/test/golden/.
 *
 *   node --import tsx scripts/golden-capture.mts            all groups
 *   node --import tsx scripts/golden-capture.mts G1 G3      some groups
 *
 * Each group runs in a child process with TZ=America/Phoenix (server/test/golden/captureCli.ts), the
 * zone this install runs in, and its encoded JSON is written to server/test/golden/<group>.json.
 * FROZEN.sha256 is then rewritten with the sha256 of every golden file. goldenFrozen.test.ts holds
 * the files to that manifest, so a golden can change only together with a visible manifest change in
 * the same diff.
 *
 * Capture on an UNCHANGED tree: the goldens describe what the code computes today. A lane that moves
 * a reader must leave every golden byte-identical; it re-points the probe, never the golden.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const GOLDEN = join(SERVER, 'test', 'golden');
const ALL = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
const groups = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

mkdirSync(GOLDEN, { recursive: true });
for (const g of groups) {
  if (!ALL.includes(g)) { console.error(`unknown group ${g}`); process.exit(2); }
  const t0 = Date.now();
  const out = execFileSync(process.execPath, ['--import', 'tsx', join(GOLDEN, 'captureCli.ts'), g], {
    cwd: SERVER,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'America/Phoenix', TSX_DISABLE_CACHE: '1' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(join(GOLDEN, `${g}.json`), out);
  console.log(`${g}: ${(out.length / 1024).toFixed(0)} KiB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

const files = readdirSync(GOLDEN).filter((f) => /^G\d+\.json$/.test(f)).sort();
const manifest = files.map((f) => `${createHash('sha256').update(readFileSync(join(GOLDEN, f))).digest('hex')}  ${f}`).join('\n') + '\n';
writeFileSync(join(GOLDEN, 'FROZEN.sha256'), manifest);
console.log(`FROZEN.sha256: ${files.length} file(s)`);
