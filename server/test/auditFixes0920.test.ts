import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.171.1 — the four confirmed findings of the 2026-09-20 log audit.
 *
 * Each is an integration path with no unit seam (the evening job, the REST client's
 * caller chain, the snapshot store's cache, the notify dispatcher), so these are source
 * pins plus the one pure behaviour that IS reachable: the empty-payload guards.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, '../src/', f), 'utf8');
const INDEX = src('index.ts');
const REST = src('ecoflow/rest.ts');
const SNAP = src('snapshot.ts');
const AM = src('alertMonitor.ts');

/* ══ 1. a prior night's ARM cannot outlive tonight's decision ══════════════ */

test('★★★ every non-charge decision cancels a prior night\'s never-applied ARM', () => {
  const fn = INDEX.indexOf('function cancelStalePriorArm(');
  assert.ok(fn > 0, 'the canceller exists');
  const body = INDEX.slice(fn, INDEX.indexOf('\n}\n', fn));
  // It clears the record…
  assert.ok(body.includes('persistNightActuation(emptyActuationState());'));
  assert.ok(body.includes("arm_disposition: `cancelled by the ${today} plan"), 'and stamps the ledger');
  // …and ONLY for an arm that is safe to clear.
  for (const guard of [
    'if (s.day == null || s.day === today) return false;',
    'if (s.targetPct == null || s.windowStartMs == null || nowMs >= s.windowStartMs) return false;',
    'if (s.appliedAtMs != null || s.applyAttemptedAtMs != null) return false;',
    'if (s.forceChargeOnAtMs != null && s.forceChargeOffVerifiedAtMs == null) return false;',
    'if (s.forceChargeCeilingPriorPct != null && s.forceChargeCeilingRestoredAtMs == null) return false;',
  ]) assert.ok(body.includes(guard), `missing guard: ${guard}`);

  // Wired into BOTH non-charge exits: the config-suppressed hold returns early.
  const holdExit = INDEX.indexOf("if (shape === 'hold' && !notifyOnHold) {");
  const holdBlock = INDEX.slice(holdExit, INDEX.indexOf('return;', holdExit));
  assert.ok(holdBlock.includes('cancelStalePriorArm(today, nowMs,'), 'the suppressed-hold early return cancels');
  const general = INDEX.indexOf("if (shape !== 'charge') {");
  assert.ok(general > 0 && general < INDEX.indexOf('let armedCandidate'), 'and so does every other non-charge shape, before arming');
});

test('★★ the 23:00 cutoff does NOT cancel — it names the arm that will write anyway', () => {
  const cut = INDEX.indexOf("night-charge: evening job missed today's");
  const block = INDEX.slice(cut, cut + 1800);
  assert.ok(block.includes('is still pending and WILL write at'), 'a no-decision night reports the pending arm');
  assert.ok(!block.includes('cancelStalePriorArm('), 'and never cancels on a night that reached no decision');
});

/* ══ 2-3. an EcoFlow "success with no data" is named, and never cached ═════ */

test('★★★ a code-0 reply with no payload throws its own named error', () => {
  assert.ok(REST.includes("if (method !== 'PUT' && parsed.data == null) {"), 'the payload is checked — on READS only');
  assert.ok(REST.includes('EcoFlow API returned success (code 0) with no data payload for ${path}'));
  const check = REST.indexOf("if (method !== 'PUT' && parsed.data == null) {");
  assert.ok(check < REST.indexOf('return parsed.data;'), 'checked before it is returned');
});

test('★★★ an empty quota never replaces a good one (the false "pack resolved" push)', () => {
  const fn = SNAP.indexOf('setDeviceQuota(sn: string');
  const body = SNAP.slice(fn, SNAP.indexOf('cur.projection = projectByProduct', fn));
  assert.ok(body.includes('if (raw == null || Object.keys(raw).length === 0) return;'));
  assert.ok(body.indexOf('return;') < body.length, 'the guard returns before the cache write');
  const guard = SNAP.indexOf('if (raw == null || Object.keys(raw).length === 0) return;');
  assert.ok(guard > 0 && guard < SNAP.indexOf('this.rawBySn.set(sn, raw);'), 'guard precedes the cache write');
});

/* ══ 4. a failed push is owed work ════════════════════════════════════════ */

test('★★★ a failed push is held for the morning digest, not dropped', () => {
  const i = AM.indexOf("const outcome = await dispatch(a, 'new');");
  const block = AM.slice(i, i + 2600);
  assert.ok(block.includes("if (outcome === 'failed') {"), 'the failure has its own branch');
  assert.ok(block.includes('existing.queued = true;'), 'held for the digest');
  assert.ok(block.includes('quietQueue.push(a)') && block.includes('persistDigestState();'), 'and it survives a restart');
  assert.ok(block.indexOf("if (outcome === 'failed') {") < block.indexOf("if (outcome !== 'failed') {"),
    'the hold runs before the success bookkeeping');
  // The retry contract is unchanged: nothing advances on failure.
  const success = block.slice(block.indexOf("if (outcome !== 'failed') {"));
  assert.ok(success.includes('existing.notified = true;') && success.includes('persistNotified();'));
});

test('★★★ v1.171.2 — a WRITE answering success with no data is a SUCCESS (the false revert CRITICAL)', () => {
  // 2026-09-21 05:05: the reserve revert reached the panel (it read 16%) but v1.171.1's
  // payload check threw on the PUT's legitimately empty reply — 15 "failures", an
  // escalation, and a spoken CRITICAL that the reserve was stuck at 50%.
  const put = REST.indexOf("call<unknown>('PUT', '/iot-open/sign/device/quota'");
  assert.ok(put > 0, 'writes go through call() as PUT');
  assert.ok(REST.includes("method !== 'PUT'"), 'the empty-payload rejection exempts writes');
});
