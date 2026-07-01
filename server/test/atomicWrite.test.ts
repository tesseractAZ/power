import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { atomicTempPath, atomicWriteFileSync, isAtomicTempFor } from '../src/atomicWrite.js';

// Private per-run directory (0700) — no predictable paths in the shared tmpdir.
const root = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));

test('atomicWriteFileSync — happy path writes the exact content', () => {
  const target = join(root, 'happy', 'state.json');
  atomicWriteFileSync(target, '{"ok":true}');
  assert.equal(readFileSync(target, 'utf8'), '{"ok":true}');
  // Creates intermediate directories (the callers' old mkdirSync behavior).
  assert.equal(dirname(target), join(root, 'happy'));
});

test('atomicWriteFileSync — overwrites an existing file via rename', () => {
  const target = join(root, 'overwrite.json');
  atomicWriteFileSync(target, 'first');
  atomicWriteFileSync(target, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'second');
});

test('atomicWriteFileSync — leaves no temp files behind on success', () => {
  const dir = join(root, 'clean');
  const target = join(dir, 'state.json');
  atomicWriteFileSync(target, 'a');
  atomicWriteFileSync(target, 'b');
  const leftovers = readdirSync(dir).filter((f) => f !== 'state.json');
  assert.deepEqual(leftovers, []);
});

test('atomicTempPath — unpredictable, same-directory, never the legacy <path>.tmp', () => {
  const target = join(root, 'state.json');
  const a = atomicTempPath(target);
  const b = atomicTempPath(target);
  assert.notEqual(a, `${target}.tmp`, 'must not be the predictable legacy name');
  assert.notEqual(a, b, 'two temp names must differ (random component)');
  assert.equal(dirname(a), dirname(target), 'temp MUST stay in the target directory (rename atomicity)');
  assert.ok(a.startsWith(`${target}.`) && a.endsWith('.tmp'));
});

test('atomicWriteFileSync — failure cleans up the temp and throws (target is a directory)', () => {
  const dir = join(root, 'fail');
  const target = join(dir, 'occupied');
  mkdirSync(target, { recursive: true }); // rename(tmp, target) onto a non-empty-dir path fails
  writeFileSync(join(target, 'keep.txt'), 'x'); // non-empty so rename can't replace it
  assert.throws(() => atomicWriteFileSync(target, 'data'));
  const leftovers = readdirSync(dir).filter((f) => f !== 'occupied');
  assert.deepEqual(leftovers, [], 'no orphaned temp file after a failed persist');
});

/* ── v0.79.0 — crash-orphan self-heal ────────────────────────────────────── */

test('atomicWriteFileSync — sweeps crash-orphaned temps for the SAME target on the next save', () => {
  const dir = join(root, 'orphans');
  const target = join(dir, 'state.json');
  mkdirSync(dir, { recursive: true });
  // Simulate a power-cut orphan from an earlier process (random name, dead pid).
  const orphan = join(dir, 'state.json.99999.abcdefabcdef.tmp');
  writeFileSync(orphan, 'half-written');
  // Decoys that merely share the prefix must survive: a legacy-style name that
  // doesn't match the pid+hex pattern, an unrelated sibling target, and ITS orphan.
  const legacy = join(dir, 'state.json.tmp');
  const sibling = join(dir, 'state.json.bak');
  const otherOrphan = join(dir, 'other.json.11111.abcdefabcdef.tmp');
  for (const f of [legacy, sibling, otherOrphan]) writeFileSync(f, 'x');

  atomicWriteFileSync(target, 'fresh');

  const names = readdirSync(dir).sort();
  assert.ok(!names.includes('state.json.99999.abcdefabcdef.tmp'), 'the dead orphan is reclaimed');
  assert.ok(names.includes('state.json.tmp'), 'non-matching legacy name untouched');
  assert.ok(names.includes('state.json.bak'), 'unrelated sibling untouched');
  assert.ok(names.includes('other.json.11111.abcdefabcdef.tmp'), "another target's orphan untouched (its own save reclaims it)");
  assert.equal(readFileSync(target, 'utf8'), 'fresh');
});

test('isAtomicTempFor — matches exactly the atomicTempPath shape, nothing else', () => {
  assert.equal(isAtomicTempFor('state.json', 'state.json.123.abcdef012345.tmp'), true);
  assert.equal(isAtomicTempFor('state.json', 'state.json.tmp'), false); // legacy fixed name
  assert.equal(isAtomicTempFor('state.json', 'state.json.123.SHOUTY12345Z.tmp'), false); // not lower-hex
  assert.equal(isAtomicTempFor('state.json', 'state.json2.123.abcdef012345.tmp'), false); // different target
  assert.equal(isAtomicTempFor('state.json', 'state.json.abc.abcdef012345.tmp'), false); // pid must be digits
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
