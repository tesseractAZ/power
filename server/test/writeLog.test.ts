import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the v0.9.6 write audit log. The WRITE_LOG_PATH env var points
 * writeLog at a temp file so we don't collide with any real
 * /data/writes.log on the host. Must be set BEFORE the dynamic import
 * because writeLog freezes the path at module-load.
 */

const tmpRoot = mkdtempSync(join(tmpdir(), 'ecoflow-writelog-'));
process.env.WRITE_LOG_PATH = join(tmpRoot, 'writes.log');

const { appendWriteLog, tailWriteLog } = await import('../src/writeLog.js');

test('appendWriteLog + tailWriteLog round-trip (newest first)', () => {
  appendWriteLog({
    ts: 1000,
    action: 'reboot-shp2',
    sn: 'HD31TESTSN',
    source: { ip: '127.0.0.1', ua: 'test-suite' },
    outcome: 'success',
    code: '0',
    message: 'ok',
    durationMs: 42,
  });
  appendWriteLog({
    ts: 2000,
    action: 'send-command',
    sn: 'HD31TESTSN',
    params: { cmdSet: 11, cmdId: 17 },
    source: { ip: '127.0.0.1' },
    outcome: 'failure',
    code: '6004',
    message: 'unsupported command',
  });
  const entries = tailWriteLog(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'send-command');
  assert.equal(entries[1].action, 'reboot-shp2');
  assert.equal(entries[0].outcome, 'failure');
  assert.equal(entries[1].outcome, 'success');
  assert.deepEqual(entries[0].params, { cmdSet: 11, cmdId: 17 });
});

test('tailWriteLog respects the limit (most recent first)', () => {
  for (let i = 0; i < 20; i++) {
    appendWriteLog({
      ts: 10_000 + i,
      action: 'reboot-shp2',
      sn: 'HD31TESTSN',
      source: {},
      outcome: 'success',
    });
  }
  const entries = tailWriteLog(5);
  assert.equal(entries.length, 5);
  assert.equal(entries[0].ts, 10_019);
  assert.equal(entries[4].ts, 10_015);
});

test('tailWriteLog handles non-existent file gracefully', () => {
  // Point at a fresh path that doesn't exist yet — must not throw.
  process.env.WRITE_LOG_PATH = join(tmpRoot, 'nonexistent', 'writes.log');
  // The path was already frozen, so this test demonstrates a different
  // property: a fresh module instance with a missing file returns [].
  // We can't re-import here (cached), but the empty-path branch is
  // unit-testable by deleting the file and re-tailing.
  rmSync(join(tmpRoot, 'writes.log'), { force: true });
  process.env.WRITE_LOG_PATH = join(tmpRoot, 'writes.log');
  // After the rm the original tail should now return []
  const entries = tailWriteLog(5);
  assert.equal(entries.length, 0);
});

test('cleanup tmp dir', () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
