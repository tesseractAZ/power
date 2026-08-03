import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// v0.11.0 — the persistence path is read at module-load time (PATH constant),
// so the env override MUST be set BEFORE the import. Use a unique tmp file so
// this suite never collides with a real /data file or a parallel run.
const SETTINGS_PATH = resolve(tmpdir(), `alert-settings-test-${process.pid}-${Date.now()}.json`);
process.env.ALERT_SETTINGS_PATH = SETTINGS_PATH;

const {
  getAlertSettings,
  isPriorityEnabled,
  updateAlertSettings,
  _resetAlertSettingsCacheForTest,
} = await import('../src/alertSettings.js');

test('defaults — all four priorities enabled', () => {
  const s = getAlertSettings();
  assert.equal(s.priorityEnabled.critical, true);
  assert.equal(s.priorityEnabled.high, true);
  assert.equal(s.priorityEnabled.medium, true);
  assert.equal(s.priorityEnabled.low, true);
});

test('updateAlertSettings — disabling a priority persists to disk', () => {
  const next = updateAlertSettings({ priorityEnabled: { critical: false } });
  assert.equal(next.priorityEnabled.critical, false);
  // Other priorities untouched.
  assert.equal(next.priorityEnabled.high, true);
  // isPriorityEnabled reflects the live cache.
  assert.equal(isPriorityEnabled('critical'), false);
  assert.equal(isPriorityEnabled('high'), true);
  // The settings file now exists on disk.
  assert.ok(existsSync(SETTINGS_PATH), 'settings file should be written');
});

// v1.60.0 — an alert-settings.json written by an OLDER build carries keys this
// build no longer knows about (a retired knob, say). sanitize() starts from
// defaults() and copies across only RECOGNISED keys, so a stale field is dropped
// silently: it neither crashes the load nor survives onto the returned object.
// That property is exactly what makes removing a settings field migration-free,
// so it is asserted here rather than assumed.
test('sanitize — an unrecognised key on disk is ignored, not carried through', () => {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ priorityEnabled: { low: false }, retiredKnob: 3, updatedAt: 42 }),
  );
  _resetAlertSettingsCacheForTest();
  const s = getAlertSettings();
  assert.equal(isPriorityEnabled('low'), false, 'recognised keys still load');
  assert.equal(s.updatedAt, 42, 'recognised scalars still load');
  assert.equal(Object.hasOwn(s, 'retiredKnob'), false, 'an unknown key must not survive sanitize()');
  // Restore the state the next test expects (critical disabled + persisted).
  updateAlertSettings({ priorityEnabled: { critical: false, low: true } });
});

test('_resetAlertSettingsCacheForTest — re-reads persisted value from disk', () => {
  // critical was disabled (and persisted) above. Drop the in-memory cache so the
  // next read must re-load from the file — the on-disk value should still hold.
  _resetAlertSettingsCacheForTest();
  assert.equal(isPriorityEnabled('critical'), false);
});

test('cleanup tmp file', () => {
  rmSync(SETTINGS_PATH, { force: true });
  assert.ok(true);
});
