/**
 * Tests for the telnet TUI block-glyph big font (src/telnet/bigfont.ts).
 *
 * The invariants the layout code depends on:
 *
 *   1. bigText() always returns exactly BIG_ROWS rows of equal length —
 *      ragged rows would shear any box drawn around the readout.
 *   2. bigTextWidth() equals the actual rendered row length for any input,
 *      so callers can reserve/centre space without rendering twice.
 *   3. Unsupported characters degrade to space-width blanks — a formatter
 *      emitting an unexpected character must never throw or skew widths.
 *   4. Output contains only single-cell block glyphs and spaces (no ANSI,
 *      nothing multi-cell), so JS .length equals on-screen columns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigText, bigTextWidth, BIG_ROWS } from '../src/telnet/bigfont.js';

/** Every character the font covers, per the module's design contract. */
const SUPPORTED = [...'0123456789.-+%:/kWh '];

test('every supported char renders BIG_ROWS equal-width rows', () => {
  for (const ch of SUPPORTED) {
    const rows = bigText(ch);
    assert.equal(rows.length, BIG_ROWS, `rows for ${JSON.stringify(ch)}`);
    const w = rows[0].length;
    assert.ok(w > 0, `zero-width glyph for ${JSON.stringify(ch)}`);
    for (const row of rows) {
      assert.equal(row.length, w, `ragged rows for ${JSON.stringify(ch)}: ${JSON.stringify(rows)}`);
    }
    assert.equal(bigTextWidth(ch), w, `width mismatch for ${JSON.stringify(ch)}`);
  }
});

test('rendered rows contain only block glyphs and spaces', () => {
  for (const ch of SUPPORTED) {
    for (const row of bigText(ch)) {
      assert.match(row, /^[█▀▄ ]*$/, `foreign character in glyph for ${JSON.stringify(ch)}`);
    }
  }
});

test('unsupported chars degrade to space-width blanks, not throws', () => {
  const spaceWidth = bigTextWidth(' ');
  for (const ch of ['X', 'a', '@', 'é', '☃', '\t']) {
    const rows = bigText(ch);
    assert.equal(rows.length, BIG_ROWS);
    for (const row of rows) {
      assert.equal(row.length, spaceWidth, `unsupported ${JSON.stringify(ch)} not space-width`);
      assert.equal(row.trim(), '', `unsupported ${JSON.stringify(ch)} rendered visible glyphs`);
    }
    assert.equal(bigTextWidth(ch), spaceWidth);
  }
});

test('bigTextWidth matches rendered row length for composite strings', () => {
  for (const s of ['100%', '12.4kW', '-5', '23:59', '+2.5kWh', '8/42', '3.1 kW x?']) {
    const rows = bigText(s);
    assert.equal(rows.length, BIG_ROWS);
    const w = rows[0].length;
    for (const row of rows) {
      assert.equal(row.length, w, `ragged rows for ${JSON.stringify(s)}`);
    }
    assert.equal(bigTextWidth(s), w, `width mismatch for ${JSON.stringify(s)}`);
  }
});

test('empty string renders BIG_ROWS empty rows', () => {
  const rows = bigText('');
  assert.deepEqual(rows, ['', '', '', '', '']);
  assert.equal(bigTextWidth(''), 0);
});

test('rendering is deterministic', () => {
  assert.deepEqual(bigText('12.4kW'), bigText('12.4kW'));
  assert.equal(bigTextWidth('23:59'), bigTextWidth('23:59'));
});
