/**
 * v1.187.16 — every write route (POST/PUT/PATCH/DELETE) registered in index.ts carries the write
 * gate (requireWriteAuth). Until v1.187.16 two did not (/api/energy-history/backfill and
 * /api/alerts/outcome), while DOCS stated every write is gated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

test('★★★ every write route registered in index.ts is behind requireWriteAuth', () => {
  const routes = [...SRC.matchAll(/app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)];
  assert.ok(routes.length >= 10, `found ${routes.length} write routes — the pattern must still match`);
  const ungated = routes.filter((m) => {
    const head = SRC.slice(m.index!, m.index! + 600).split(/async\s*\(/)[0];
    return !/requireWriteAuth/.test(head);
  }).map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(ungated, []);
});
