import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClearedLog, saveClearedLog } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';

/**
 * v0.85.1 — cleared-alert history persistence (the sidecar behind the Alerts→
 * Cleared view). Extracted to exported loadClearedLog/saveClearedLog so the
 * rehydrate + bounding + garbage-rejection logic is unit-tested, mirroring the
 * notify-state persistence tests. Best-effort I/O: a corrupt/missing file must
 * degrade to an empty log, never throw (history never gates a live alarm).
 */

const dir = mkdtempSync(join(tmpdir(), 'clearedlog-'));
const p = join(dir, 'cleared-alerts.json');
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

const mkAlert = (id: string): Alert => ({
  id, severity: 'warning', category: 'Battery', device: 'System', title: `t-${id}`, detail: 'd',
});
const mkCleared = (id: string, raisedAt = 1000, clearedAt = 2000) => ({
  alert: mkAlert(id), raisedAt, clearedAt, durationMs: clearedAt - raisedAt,
});

test('round-trips: save then load returns the same records (newest-first order preserved)', () => {
  const log = [mkCleared('a'), mkCleared('b'), mkCleared('c')];
  saveClearedLog(p, log, 500);
  assert.ok(existsSync(p));
  const back = loadClearedLog(p, 500);
  assert.equal(back.length, 3);
  assert.deepEqual(back.map((c) => c.alert.id), ['a', 'b', 'c']);
  assert.equal(back[0].durationMs, 1000);
});

test('save caps to max (bounding on write)', () => {
  const log = Array.from({ length: 10 }, (_, i) => mkCleared(`x${i}`));
  saveClearedLog(p, log, 3);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(raw.length, 3);
  assert.deepEqual(raw.map((c: any) => c.alert.id), ['x0', 'x1', 'x2']); // newest-first slice
});

test('load caps to max (bounding on read)', () => {
  const log = Array.from({ length: 10 }, (_, i) => mkCleared(`y${i}`));
  saveClearedLog(p, log, 500); // persist all 10
  const back = loadClearedLog(p, 4);
  assert.equal(back.length, 4);
});

test('garbage records are dropped; well-formed ones survive', () => {
  const mixed = [
    mkCleared('good1'),
    { alert: mkAlert('nofin'), raisedAt: NaN, clearedAt: 2000, durationMs: 0 }, // non-finite raisedAt
    { raisedAt: 1, clearedAt: 2, durationMs: 1 },                               // missing alert
    { alert: 'not-an-object', raisedAt: 1, clearedAt: 2, durationMs: 1 },       // alert not object
    null,
    mkCleared('good2'),
  ];
  writeFileSync(p, JSON.stringify(mixed));
  const back = loadClearedLog(p, 500);
  assert.deepEqual(back.map((c) => c.alert.id), ['good1', 'good2']);
});

test('a non-array JSON file loads as empty (not a crash)', () => {
  writeFileSync(p, JSON.stringify({ not: 'an array' }));
  assert.deepEqual(loadClearedLog(p, 500), []);
});

test('a corrupt / non-JSON file loads as empty (best-effort, never throws)', () => {
  writeFileSync(p, '{ this is not json ]');
  assert.deepEqual(loadClearedLog(p, 500), []);
});

test('a missing file loads as empty', () => {
  assert.deepEqual(loadClearedLog(join(dir, 'does-not-exist.json'), 500), []);
  cleanup();
});
