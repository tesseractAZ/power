import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfConsumptionCoverage } from '../src/analytics.js';

// v0.69.0 — guards the home-core coverage flag. The load-bearing case is the last
// one: when the SHP2 itself is cloud-offline it reports ZERO connectors, and a naive
// `reporting < connected` would read `N < 0 = false` ("fine") — masking the window
// where the KPI is least trustworthy. That silent failure is what this pins down.

const dev = (online?: boolean) => ({ online });

test('full coverage — all wired home cores online → not partial', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }, { sn: 'c' }],
    { a: dev(true), b: dev(true), c: dev(true) },
    true,
  );
  assert.deepEqual(r, { homeDpusConnected: 3, homeDpusReporting: 3, coveragePartial: false });
});

test('one wired core cloud-offline → partial', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }, { sn: 'c' }],
    { a: dev(true), b: dev(true), c: dev(false) },
    true,
  );
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, true);
});

test('wired core dropped from homeDpus (no live projection) → partial', () => {
  // `connected` still lists c (it comes from the SHP2 connector roster, independent of
  // whether we have a projection), but homeDpus omits it → reporting 2 < connected 3.
  const r = selfConsumptionCoverage(
    new Set(['a', 'b', 'c']),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true), b: dev(true), c: dev(true) },
    true,
  );
  assert.equal(r.homeDpusConnected, 3);
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, true);
});

test('SHP2 cloud-offline — zero connectors but SHP2 present → PARTIAL (the v0.69.0 fix)', () => {
  const r = selfConsumptionCoverage(
    new Set(),
    [{ sn: 'a' }, { sn: 'b' }], // homeDpus expands to all DPUs when membership is empty
    { a: dev(true), b: dev(true) },
    true,
  );
  assert.equal(r.homeDpusConnected, 0);
  assert.equal(r.homeDpusReporting, 0, 'no authoritative roster → 0 confirmed reporting');
  assert.equal(r.coveragePartial, true, 'SHP2 present + no connectors = membership unknown = partial');
});

test('DPU-only install (no SHP2) → never partial', () => {
  const r = selfConsumptionCoverage(
    new Set(),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true), b: dev(true) },
    false,
  );
  assert.equal(r.coveragePartial, false);
});

test('a device missing from the map counts as reporting (online undefined !== false)', () => {
  const r = selfConsumptionCoverage(
    new Set(['a', 'b']),
    [{ sn: 'a' }, { sn: 'b' }],
    { a: dev(true) }, // b absent
    true,
  );
  assert.equal(r.homeDpusReporting, 2);
  assert.equal(r.coveragePartial, false);
});
