import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S8, lane D) — index.ts reads the device topology through topology.ts: the warranty
 * export's default chassis (X1), the reconnect watch's product kind, the self-heal quorum bounded by
 * the account (Z5), the home roster forwarded to the analytics worker (CA17) and the boot line naming
 * the spare floor and alias layers. The behaviour behind each line is tested in topology.test.ts,
 * benchSpare.test.ts, deviceAliases.test.ts and selfHealAccountQuorum.test.ts; this holds the
 * production wiring to it, so a helper that is tested but never called cannot pass.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');

test('★★★ the warranty export picks its default chassis through warrantyChassis, and answers 400 when there is none', () => {
  for (const pin of [
    '  const pick = warrantyChassis(req.query.sn, sn, store.get().devices, listConfirmedRecords().map((r) => r.deviceSn));',
    "  if ('error' in pick) { reply.code(400); return { error: pick.error, candidates: pick.candidates }; }",
    '  const chassis = pick.sn;',
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
  // OWNER DECISION 2 keeps the one default serial in this file (check-no-secrets pins index.ts: 1).
  const serials = idx.match(/(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/g) ?? [];
  assert.equal(serials.filter((t) => /^Y711/.test(t)).length, 1);
  assert.match(idx, /const sn = req\.query\.sn \?\? '[A-Z0-9]{16}';/);
});

test('★★ the reconnect watch classifies a projection-less device with productKind', () => {
  assert.ok(idx.includes("      : productKind(d.productName); // v1.191.0 (S8) — the same two tests, in the same order"));
  assert.ok(!/\/delta pro ultra\/i\.test|\/smart home panel\/i\.test/.test(idx), 'no inline product regex left in index.ts');
});

test('★★ the self-heal quorum is told how many devices are on the account', () => {
  assert.ok(idx.includes('{ alarmCriticalStarved, accountDevices: Object.keys(devices).length }'));
});

test('★★ CA17: the home roster reaches the analytics worker at boot and on every change', () => {
  const pushes = idx.match(/analytics\.pushHomeRoster\?\.\(\[\.\.\.lastKnownRoster\]\);/g) ?? [];
  assert.equal(pushes.length, 2, 'seeded once after the client exists, and from noteLiveRoster');
  const note = idx.slice(idx.indexOf('export function noteLiveRoster'), idx.indexOf('export function noteLiveRoster') + 800);
  assert.ok(note.includes('analytics.pushHomeRoster?.([...lastKnownRoster]);'), 'noteLiveRoster forwards the roster');
});

test('the boot log names the bench-spare floor and the alias layers', () => {
  assert.ok(idx.includes('`devices: bench-spare floor ${spares == null ?'));
  assert.ok(idx.includes('display aliases: image ${bySource(\'image\')}, data ${bySource(\'data\')}, option ${bySource(\'option\')}'));
});
