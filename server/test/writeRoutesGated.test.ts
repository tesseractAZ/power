/**
 * v1.187.16 — every write route (POST/PUT/PATCH/DELETE) registered in index.ts carries the write
 * gate (requireWriteAuth). Until v1.187.16 two did not (/api/energy-history/backfill and
 * /api/alerts/outcome), while DOCS stated every write is gated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const SRC = readFileSync(resolve(SRC_DIR, 'index.ts'), 'utf8');

test('★★★ every write route registered in index.ts is behind requireWriteAuth', () => {
  const routes = [...SRC.matchAll(/app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)];
  assert.ok(routes.length >= 10, `found ${routes.length} write routes — the pattern must still match`);
  const ungated = routes.filter((m) => {
    const head = SRC.slice(m.index!, m.index! + 600).split(/async\s*\(/)[0];
    return !/requireWriteAuth/.test(head);
  }).map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(ungated, []);
});

/** Every .ts file under server/src, so a write route registered outside index.ts is seen too. */
function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = resolve(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// v1.187.20 — the backup-window hook routes live in backupWindow.ts, registered with a template
// literal, so the index.ts scan above saw neither. They are gated by the loopback socket peer
// (requireLoopbackPeer), not by requireWriteAuth: the Supervisor's docker-exec'd hook has no token.
test('★★★ every write route in ANY server module is gated: requireWriteAuth, or loopback-only', () => {
  const found: string[] = [];
  const ungated: string[] = [];
  for (const file of srcFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*(['`])([^'`]+)\2/g)) {
      const name = `${m[1].toUpperCase()} ${m[3]} (${file.slice(SRC_DIR.length + 1)})`;
      found.push(name);
      const head = text.slice(m.index!, m.index! + 600).split(/async\s*\(/)[0];
      if (!/requireWriteAuth|requireLoopbackPeer/.test(head)) ungated.push(name);
    }
  }
  assert.ok(found.some((n) => n.includes('backupWindow.ts')), 'the backup-window routes are seen');
  assert.ok(found.length >= 12, `found ${found.length} write routes — the pattern must still match`);
  assert.deepEqual(ungated, []);
});
