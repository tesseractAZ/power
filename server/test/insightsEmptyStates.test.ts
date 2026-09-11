import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.147.0 — the last three vanish-on-empty sections in AdvancedInsightsCard.
 *
 * v1.131.1 rejected this pattern in the same file and said why: *"a blank row
 * reads as a healthy one. This detector published nothing for its entire life
 * and looked fine doing it."* Three sections still took the vanish path — a
 * detector that cannot produce a value looked identical to one that was never
 * enabled, on the screen a human reads.
 *
 * The reason is not invented. Two of the three reports already publish a per-item
 * `status` computed server-side, and `insufficient-cadence` carries an explicit
 * comment saying it exists *"so the UI stops showing a perpetual spinner for a
 * measurement that can't complete"* — the UI was discarding exactly the field
 * that was added for it.
 */

const card = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src/cards/AdvancedInsightsCard.tsx'),
  'utf8',
);

/** The children of one `{show('key') && …}` block, up to the next one. */
function section(key: string): string {
  const i = card.indexOf(`{show('${key}')`);
  assert.ok(i > 0, `section ${key} located`);
  const next = card.indexOf("{show('", i + 10);
  return card.slice(i, next > i ? next : card.length);
}

const CASES: Array<[string, RegExp]> = [
  ['charge-curve', /Building the baseline/],
  ['internal-resistance', /will not converge without faster sampling/],
  ['ambient-thermal', /no fit has converged yet/],
];

for (const [key, expected] of CASES) {
  test(`★ '${key}' renders an explanatory empty state instead of vanishing`, () => {
    const s = section(key);
    // The guard must NOT require an item to have data — that is the vanish.
    assert.ok(
      !/&&\s*\w+\.(packs|devices)\.some\(\([^)]*\)\s*=>\s*\w+\.\w+\s*!=\s*null\)\s*&&\s*\(/.test(s),
      `${key}: the section must not be gated on an item HAVING a value`,
    );
    // …and it must say which empty it is.
    assert.match(s, expected, `${key}: the empty state must state the reason`);
    // The EMPTY-STATE div specifically — not merely "text-muted appears somewhere
    // in this section". A mutant that repaints this one div healthy leaves every
    // other muted class in place, and a loose scan sails past it.
    const block = emptyStateBlock(s, key);
    assert.match(block, /className="text-xs text-muted"/,
      `${key}: an absence must render NEUTRAL, never the healthy colour`);
  });
}

/** The `{!x.some(...) && ( <div …> … )}` block that renders the empty state. */
function emptyStateBlock(s: string, key: string): string {
  const i = s.indexOf('&& (\n            <div className=');
  assert.ok(i > 0, `${key}: an empty-state block exists at all`);
  return s.slice(i, i + 400);
}

test("★ 'internal-resistance' surfaces the server's own terminal status", () => {
  // `insufficient-cadence` is documented as the HONEST TERMINAL state — it will
  // never converge at the current poll rate. Distinguishing it from 'learning'
  // is the whole point; collapsing them restores the perpetual spinner.
  //
  // Pin the BRANCH, not the string: a mutant that prefixes the condition with
  // `false &&` leaves the literal in place and a text scan still passes.
  const block = emptyStateBlock(section('internal-resistance'), 'internal-resistance');
  assert.match(
    block,
    /\{ir\.devices\.some\(\(d\) => d\.status === 'insufficient-cadence'\)\s*\n?\s*\?/,
    'the terminal status must be the live ternary condition, not dead text',
  );
  assert.match(block, /status === 'learning'/);
  assert.ok(!/false &&/.test(block), 'no short-circuit may disable the terminal branch');
});

test("'charge-curve' distinguishes baseline-building from no-data", () => {
  const s = section('charge-curve');
  assert.match(s, /status === 'baseline'/);
  assert.match(s, /No packs reporting/);
});

test('the rows themselves are unchanged — a populated section still renders', () => {
  // The fix must not alter what a HEALTHY section shows.
  for (const [key, filterField] of [
    ['charge-curve', 'meanDriftMv'],
    ['internal-resistance', 'recentMilliohms'],
    ['ambient-thermal', 'predictedPeak24hC'],
  ] as const) {
    assert.match(
      section(key), new RegExp(`filter\\(\\([a-z]\\) => [a-z]\\.${filterField} != null\\)`),
      `${key}: rows are still filtered to items that HAVE a value`,
    );
  }
});
