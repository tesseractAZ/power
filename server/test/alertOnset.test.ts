import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.x (r25) — the restart-persistent alarm-onset sidecar. Pins the three
 * properties the ALM screen relies on to show each alarm's TRUE first-seen
 * time instead of the per-refresh snapshot.generatedAt stamp:
 *   (1) an id's onset is stamped once and does NOT drift on later ticks;
 *   (2) a cleared id is pruned, so its next rise is a fresh event (matching
 *       how tracked/notify-state/telemetry all treat clear-then-rise);
 *   (3) onsets survive a process restart (the whole reason for the sidecar —
 *       alertMonitor's in-memory TrackedAlert.firstSeen resets on restart).
 */

const dir = mkdtempSync(join(tmpdir(), 'ef-onset-'));
process.env.ALERT_ONSET_PATH = join(dir, 'alert-onset.json');
const ONSET = process.env.ALERT_ONSET_PATH;

const { syncAlertOnsets, getAlertOnset, loadAlertOnsets, resetAlertOnsetCacheForTests, ALERT_ONSET_MAX_AGE_MS } =
  await import('../src/alertOnset.js');

function fresh() {
  resetAlertOnsetCacheForTests();
  if (existsSync(ONSET)) rmSync(ONSET);
}

// Use recent, realistic epochs — a reload (getAlertOnset after a cache reset)
// applies the real Date.now() max-age cutoff, so ancient toy timestamps would
// be pruned on load. T is "just now".
const T = Date.now();

test('onset — first-seen is recorded and does NOT drift on later ticks', () => {
  fresh();
  syncAlertOnsets(['soc-low-A'], T);
  assert.equal(getAlertOnset('soc-low-A'), T);
  // Same id still active on a later tick: onset must stay at first-seen, not
  // re-stamp to the latest tick (that would make every alarm look brand new).
  syncAlertOnsets(['soc-low-A'], T + 4000);
  assert.equal(getAlertOnset('soc-low-A'), T, 'onset must stay at first-seen, not drift to the latest tick');
});

test('onset — a cleared id is pruned; its next rise gets a fresh onset', () => {
  fresh();
  syncAlertOnsets(['x'], T);
  assert.equal(getAlertOnset('x'), T);
  syncAlertOnsets([], T + 1000); // condition cleared → id absent
  assert.equal(getAlertOnset('x'), undefined, 'a cleared id is pruned');
  syncAlertOnsets(['x'], T + 2000); // re-fires later
  assert.equal(getAlertOnset('x'), T + 2000, 'a re-fire is a NEW event and gets a fresh onset');
});

test('onset — survives a restart (persisted to disk, reloaded into a fresh cache)', () => {
  fresh();
  syncAlertOnsets(['pack-hot-Y711'], T);
  // Simulate an add-on restart: drop the in-process cache. A fresh read must
  // recover the onset from disk — exactly what makes the ALM timestamp honest
  // across the ~daily Pi power-cut restart.
  resetAlertOnsetCacheForTests();
  assert.equal(getAlertOnset('pack-hot-Y711'), T, 'onset persists across a restart');
  // The loader honours the max-age cutoff so an ancient record can't linger.
  const stale = loadAlertOnsets(ONSET, T + ALERT_ONSET_MAX_AGE_MS + 1);
  assert.equal(stale.has('pack-hot-Y711'), false, 'entries older than max-age are dropped at load');
});
