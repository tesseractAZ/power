import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSocLadder, formatSocLadder } from '../src/limits.js';
import { BATTERY_SOC_THRESHOLDS, DEFAULT_BATTERY_SOC_THRESHOLDS } from '../src/batterySocAlarm.js';
import { withEnv } from './golden/support/env.js';

/**
 * v1.191.0 (S9, Z6) — BATTERY_SOC_LADDER: the SoC alarm's rungs as `pct:tier`, comma-separated.
 * Unset, the built-in 50/40/30/20/15/10/8/4/2 ladder (golden G8 pins it); set, the rungs replace it.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

test('★ the built-in ladder is in force while the option is unset', () => {
  assert.equal(BATTERY_SOC_THRESHOLDS, DEFAULT_BATTERY_SOC_THRESHOLDS);
  assert.deepEqual(BATTERY_SOC_THRESHOLDS.map((t) => `${t.pct}:${t.priority}`).join(','),
    '50:low,40:low,30:low,20:medium,15:medium,10:critical,8:critical,4:critical,2:critical');
});

test('★ a ladder parses to its rungs and tiers, highest percent first', () => {
  assert.deepEqual(parseSocLadder('50:low,30:medium,15:critical'), [
    { pct: 50, priority: 'low' }, { pct: 30, priority: 'medium' }, { pct: 15, priority: 'critical' },
  ]);
  assert.deepEqual(parseSocLadder(' 15 : CRITICAL , 60:Low,25:high ')?.map((r) => `${r.pct}:${r.priority}`), ['60:low', '25:high', '15:critical']);
});

test('★ round trip: the built-in ladder formats and parses back to itself', () => {
  const s = formatSocLadder(DEFAULT_BATTERY_SOC_THRESHOLDS);
  assert.deepEqual(parseSocLadder(s), DEFAULT_BATTERY_SOC_THRESHOLDS.map((t) => ({ pct: t.pct, priority: t.priority })));
  for (const canon of ['50:low,30:medium,15:critical', '99:low,1:critical', '20:high']) assert.equal(formatSocLadder(parseSocLadder(canon)!), canon);
});

test('rungs that do not parse are skipped, a repeated percent keeps its first; nothing valid keeps the built-in ladder', () => {
  assert.deepEqual(parseSocLadder('0:low,100:low,abc,40:urgent,30:medium,30:critical,5')?.map((r) => `${r.pct}:${r.priority}`), ['30:medium']);
  assert.equal(parseSocLadder(undefined), null);
  assert.equal(parseSocLadder(''), null);
  assert.equal(parseSocLadder('nonsense'), null);
  assert.equal(parseSocLadder('0:low,101:critical'), null);
});

test('★ BATTERY_SOC_LADDER set replaces the ladder the alarm and the on-screen band use', async () => {
  const mod = await withEnv({ BATTERY_SOC_LADDER: '60:low,35:medium,12:critical' },
    async () => (await import(`${pathToFileURL(resolve(SRC, 'batterySocAlarm.ts')).href}?ladder=1`)) as typeof import('../src/batterySocAlarm.js'));
  assert.deepEqual(mod.BATTERY_SOC_THRESHOLDS.map((t) => t.pct), [60, 35, 12]);
  assert.equal(mod.activeSocBand(55)?.pct, 60);
  assert.equal(mod.activeSocBand(34)?.priority, 'medium');
  assert.equal(mod.activeSocBand(11)?.priority, 'critical');
  assert.equal(mod.activeSocBand(61), null);
  const invalid = await withEnv({ BATTERY_SOC_LADDER: 'not a ladder' },
    async () => (await import(`${pathToFileURL(resolve(SRC, 'batterySocAlarm.ts')).href}?ladder=2`)) as typeof import('../src/batterySocAlarm.js'));
  assert.equal(invalid.BATTERY_SOC_THRESHOLDS, invalid.DEFAULT_BATTERY_SOC_THRESHOLDS, 'a value with no valid rung keeps the built-in ladder');
});
