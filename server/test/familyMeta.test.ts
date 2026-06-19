import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';

// v0.31.0 — the per-family metadata sidecar restores real title/severity/category
// on a post-restart telemetry replay (instead of the familyKey/'info'/'Battery'
// placeholder). Point it at a temp file BEFORE importing the module, since the
// path is resolved at import time.
const TMP = `/tmp/family-meta-test-${process.pid}.json`;
process.env.ALERT_FAMILY_META_PATH = TMP;
const { loadFamilyMeta, upsertFamilyMeta } = await import('../src/alertTelemetry.js');

test.after(() => { try { rmSync(TMP); } catch { /* ignore */ } });

test('upsertFamilyMeta persists new metadata and is change-detected', () => {
  const meta = { title: 'Cell imbalance', severity: 'warning', category: 'Battery' };
  assert.equal(upsertFamilyMeta('vdiff-warn', meta), true, 'first write persists');
  assert.equal(upsertFamilyMeta('vdiff-warn', { ...meta }), false, 'identical write is a no-op');
  assert.ok(existsSync(TMP), 'sidecar file written');
});

test('loadFamilyMeta returns the upserted metadata', () => {
  const m = loadFamilyMeta();
  assert.deepEqual(m['vdiff-warn'], { title: 'Cell imbalance', severity: 'warning', category: 'Battery' });
});

test('a changed severity/title re-persists', () => {
  assert.equal(upsertFamilyMeta('vdiff-warn', { title: 'Cell imbalance', severity: 'critical', category: 'Battery' }), true);
  const onDisk = JSON.parse(readFileSync(TMP, 'utf-8'));
  assert.equal(onDisk['vdiff-warn'].severity, 'critical');
});

test('the placeholder fallback is gone once a family is known', () => {
  // The replay seeder uses loadFamilyMeta()[familyKey] — so a known family no
  // longer falls back to title===familyKey / severity==='info'.
  const m = loadFamilyMeta();
  assert.notEqual(m['vdiff-warn'].title, 'vdiff-warn');
  assert.notEqual(m['vdiff-warn'].severity, 'info');
});
