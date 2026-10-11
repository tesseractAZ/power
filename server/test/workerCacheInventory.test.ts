/**
 * v1.187.18 — every module-level result cache in analytics.ts is either reset when the worker's
 * device basis changes (resetWorkerReportCaches) or listed here with the reason it need not be.
 *
 * The reset is only as good as its list: a cache added later and left out of it would latch a
 * boot-time partial basis for its whole TTL again (2026-10-11 12:23: the degradation report served
 * 4 packs of 24 for 30 min; 13 of 25 worker reports could do the same). This test reads the source,
 * so a new `let xCache` / `const xCache = new Map` fails here until it is placed in one list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/analytics.ts'), 'utf8');

/** Caches the basis reset deliberately leaves alone, each with its reason. */
const NOT_RESET: Record<string, string> = {
  stormPrepCache: 'the NWS feed only (no device input), and read on the main thread by the alert monitor',
  dailyEnergyWhCache: 'closed-day energy integrals keyed by (day, SN, metrics): immutable once the day has ended',
  eqSeriesCache: 'bucketed recorder series keyed by (SN, metrics), topped up by tail: raw history, not a result',
  dispatchCache: 'main thread (index.ts /api/dispatch-plan): keyed on the forecast\'s generatedAt instead',
  riskCache: 'main thread (index.ts /api/pack-risk): keyed on the generatedAt of its four input reports instead',
};

function moduleCaches(): string[] {
  const names = new Set<string>();
  for (const m of SRC.matchAll(/^let\s+(\w+Cache)\b/gm)) names.add(m[1]);
  for (const m of SRC.matchAll(/^const\s+(\w+Cache)\s*=\s*new Map\b/gm)) names.add(m[1]);
  return [...names].sort();
}

function resetBody(): string {
  const at = SRC.indexOf('export function resetWorkerReportCaches(): void {');
  assert.ok(at >= 0, 'resetWorkerReportCaches exists');
  return SRC.slice(at, SRC.indexOf('\n}\n', at));
}

const resetsIt = (body: string, name: string) =>
  new RegExp(`^\\s*${name}\\s*=\\s*null;`, 'm').test(body) || new RegExp(`^\\s*${name}\\.clear\\(\\);`, 'm').test(body);

test('★★★ every module-level analytics cache is reset on a basis change, or allowlisted with a reason', () => {
  const caches = moduleCaches();
  assert.ok(caches.length >= 25, `the scan found the caches (${caches.length})`);
  const body = resetBody();
  const missing = caches.filter((c) => !resetsIt(body, c) && !(c in NOT_RESET));
  assert.deepEqual(missing, [], 'add each to resetWorkerReportCaches, or to NOT_RESET with the reason');
});

test('★★ the allowlist is not stale, and nothing is both reset and exempt', () => {
  const caches = new Set(moduleCaches());
  const body = resetBody();
  for (const [name, why] of Object.entries(NOT_RESET)) {
    assert.ok(caches.has(name), `${name} is allowlisted but no longer exists`);
    assert.ok(why.length > 20, `${name}: a reason`);
    assert.ok(!resetsIt(body, name), `${name} is allowlisted AND reset — pick one`);
  }
});

test('the reset names only caches that exist (a typo there resets nothing)', () => {
  const caches = new Set(moduleCaches());
  for (const m of resetBody().matchAll(/^\s*(\w+)(?:\s*=\s*null|\.clear\(\));/gm)) {
    assert.ok(caches.has(m[1]), `${m[1]} is reset but is not a module cache`);
  }
});

test('the inventory as of v1.187.18: 24 reset, 5 exempt', () => {
  const body = resetBody();
  const caches = moduleCaches();
  assert.equal(caches.filter((c) => resetsIt(body, c)).length, 24);
  assert.equal(caches.filter((c) => c in NOT_RESET).length, 5);
});
