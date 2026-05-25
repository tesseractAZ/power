import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSkyCoverEntry } from '../src/nws.js';

/**
 * NWS NDFD skyCover entries carry ISO 8601 durations in their `validTime`
 * field. Each entry spans 1+ hours where cloud cover is constant; the
 * expand helper turns one entry into N per-hour rows. The ISO duration
 * parser is the trickiest part of the v0.9.2 ensemble — these tests pin
 * its behavior against the formats NWS actually emits.
 */

test('expandSkyCoverEntry — empty/invalid input returns []', () => {
  assert.deepEqual(expandSkyCoverEntry({}), []);
  assert.deepEqual(expandSkyCoverEntry({ validTime: 'garbage' }), []);
  assert.deepEqual(expandSkyCoverEntry({ validTime: '2026-05-25T12:00:00+00:00/PT3H' }), []); // missing value
  assert.deepEqual(expandSkyCoverEntry({ value: 30 }), []); // missing validTime
});

test('expandSkyCoverEntry — PT1H produces a single row', () => {
  const start = '2026-05-25T12:00:00+00:00';
  const out = expandSkyCoverEntry({ validTime: `${start}/PT1H`, value: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].cloudCoverPct, 30);
  assert.equal(out[0].ts, Date.parse(start));
});

test('expandSkyCoverEntry — PT3H produces 3 contiguous hourly rows', () => {
  const start = '2026-05-25T18:00:00+00:00';
  const out = expandSkyCoverEntry({ validTime: `${start}/PT3H`, value: 50 });
  assert.equal(out.length, 3);
  assert.equal(out[0].ts, Date.parse(start));
  assert.equal(out[1].ts, Date.parse(start) + 3_600_000);
  assert.equal(out[2].ts, Date.parse(start) + 2 * 3_600_000);
  for (const h of out) assert.equal(h.cloudCoverPct, 50);
});

test('expandSkyCoverEntry — P1DT6H produces 30 rows (24+6)', () => {
  const start = '2026-05-25T00:00:00+00:00';
  const out = expandSkyCoverEntry({ validTime: `${start}/P1DT6H`, value: 10 });
  assert.equal(out.length, 30);
  assert.equal(out[0].ts, Date.parse(start));
  assert.equal(out[29].ts, Date.parse(start) + 29 * 3_600_000);
});

test('expandSkyCoverEntry — PT12H, common NWS overnight span', () => {
  const start = '2026-05-25T06:00:00+00:00';
  const out = expandSkyCoverEntry({ validTime: `${start}/PT12H`, value: 80 });
  assert.equal(out.length, 12);
  for (const h of out) assert.equal(h.cloudCoverPct, 80);
});

test('expandSkyCoverEntry — value of 0 (clear sky) preserved, not nullish-coalesced away', () => {
  const out = expandSkyCoverEntry({ validTime: '2026-05-25T12:00:00+00:00/PT2H', value: 0 });
  assert.equal(out.length, 2);
  assert.equal(out[0].cloudCoverPct, 0);
  assert.equal(out[1].cloudCoverPct, 0);
});

test('expandSkyCoverEntry — unknown duration format defaults to 1 hour', () => {
  const start = '2026-05-25T12:00:00+00:00';
  const out = expandSkyCoverEntry({ validTime: `${start}/junk`, value: 25 });
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, Date.parse(start));
});
