import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hbar, vscale, braille, tile, fracLabel } from '../src/telnet/gauges.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * telnet TUI gauge primitives — pure string functions, so every case pins an
 * exact expected string. Two invariants dominate: (1) output width is always
 * exactly the requested width (layout code counts on it), and (2) no input —
 * NaN, ±Infinity, nulls, negative width — may throw or emit ANSI bytes.
 * ═════════════════════════════════════════════════════════════════════════ */

/* ─── hbar — eighth-block horizontal bar ──────────────────────────────── */

test('hbar: half fill lands on a cell boundary', () => {
  assert.equal(hbar(0.5, 4), '██  ');
});

test('hbar: full and empty', () => {
  assert.equal(hbar(1, 3), '███');
  assert.equal(hbar(0, 3), '   ');
});

test('hbar: single-eighth partial cell', () => {
  // 1/16 of 2 cells = 1 eighth-step → one '▏' then padding.
  assert.equal(hbar(1 / 16, 2), '▏ ');
});

test('hbar: every eighth-block boundary in one cell', () => {
  const ramp = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
  for (let i = 0; i <= 8; i++) {
    assert.equal(hbar(i / 8, 1), ramp[i], `frac=${i}/8`);
  }
});

test('hbar: partial cell rides on top of full cells', () => {
  // 5/8 of 2 cells = 10 eighth-steps = 1 full cell + 2 eighths.
  assert.equal(hbar(5 / 8, 2), '█▎');
});

test('hbar: nearest-step rounding', () => {
  // 0.99 * 8 = 7.92 → rounds to the full block, not '▉'.
  assert.equal(hbar(0.99, 1), '█');
});

test('hbar: frac clamps — NaN/negative → empty bar, >1/+Infinity → full bar', () => {
  assert.equal(hbar(Number.NaN, 4), '    ');
  assert.equal(hbar(-5, 4), '    ');
  assert.equal(hbar(-Infinity, 4), '    ');
  assert.equal(hbar(2, 3), '███');
  assert.equal(hbar(Infinity, 3), '███');
});

test('hbar: invalid width → empty string', () => {
  assert.equal(hbar(0.5, 0), '');
  assert.equal(hbar(0.5, -2), '');
  assert.equal(hbar(0.5, Number.NaN), '');
  assert.equal(hbar(0.5, Infinity), '');
});

test('hbar: fractional width floors', () => {
  assert.equal(hbar(1, 2.9), '██');
});

/* ─── vscale — eighth-height column chart ─────────────────────────────── */

test('vscale: monotonic ramp hits every level', () => {
  assert.equal(vscale([0, 1, 2, 3, 4, 5, 6, 7, 8], 9), ' ▁▂▃▄▅▆▇█');
});

test('vscale: explicit bounds position the value', () => {
  assert.equal(vscale([5], 1, 0, 10), '▄');
});

test('vscale: values beyond explicit bounds clamp', () => {
  assert.equal(vscale([-5, 15], 2, 0, 10), ' █');
});

test('vscale: nulls render as gaps, not zeros', () => {
  assert.equal(vscale([null, 4, null, 8], 4, 0, 8), ' ▄ █');
});

test('vscale: non-finite samples are skipped like nulls', () => {
  assert.equal(vscale([Number.NaN, 4, Infinity, 8], 4, 0, 8), ' ▄ █');
});

test('vscale: degenerate range renders mid-height for non-null', () => {
  assert.equal(vscale([3, 3, 3], 3), '▄▄▄');
  assert.equal(vscale([null, 7], 2), ' ▄');
});

test('vscale: empty and all-null series render blank at full width', () => {
  assert.equal(vscale([], 4), '    ');
  assert.equal(vscale([null, null], 4), '    ');
});

test('vscale: downsampling buckets by mean', () => {
  // [0,8,0,8] → two buckets, each mean 4 of range 0..8 → mid-height.
  assert.equal(vscale([0, 8, 0, 8], 2, 0, 8), '▄▄');
  assert.equal(vscale([0, 0, 8, 8], 2, 0, 8), ' █');
});

test('vscale: upsampling repeats samples across their share of columns', () => {
  assert.equal(vscale([0, 8], 4, 0, 8), '  ██');
});

test('vscale: bucket mean skips a null but keeps the numeric neighbour', () => {
  // Bucket [null, 8] → mean of the one usable sample.
  assert.equal(vscale([null, 8, 0, 0], 2, 0, 8), '█ ');
});

test('vscale: invalid width → empty string', () => {
  assert.equal(vscale([1, 2], 0), '');
  assert.equal(vscale([1, 2], -1), '');
  assert.equal(vscale([1, 2], Number.NaN), '');
});

/* ─── braille — 2×4 dot sparkline ─────────────────────────────────────── */

test('braille: low/high pair sets bottom-left and top-right dots', () => {
  // Left column level 0 → dot 7 (bit 6, 0x40); right column level 3 → dot 4
  // (bit 3, 0x08). U+2800 | 0x48 = U+2848.
  assert.equal(braille([0, 1], 1), '⡈');
});

test('braille: flat low then flat high across two cells', () => {
  // Cell 1: both columns bottom → 0x40|0x80 = U+28C0 '⣀'.
  // Cell 2: both columns top → 0x01|0x08 = U+2809 '⠉'.
  assert.equal(braille([0, 0, 1, 1], 2), '⣀⠉');
});

test('braille: all four levels, column-major bit layout', () => {
  // Levels 0,1,2,3 → rows 3,2,1,0. Cell 1: left row 3 (0x40) + right row 2
  // (0x20) = U+2860. Cell 2: left row 1 (0x02) + right row 0 (0x08) = U+280A.
  assert.equal(braille([0, 1 / 3, 2 / 3, 1], 2), '⡠⠊');
});

test('braille: null column carries no dot', () => {
  assert.equal(braille([null, 1], 1, 0, 1), '⠈');
  assert.equal(braille([0, null], 1, 0, 1), '⡀');
});

test('braille: all-null series renders blank braille cells at full width', () => {
  assert.equal(braille([null, null, null, null], 2), '⠀⠀');
});

test('braille: explicit bounds clamp out-of-range values', () => {
  assert.equal(braille([-9, 99], 1, 0, 1), '⡈');
});

test('braille: degenerate range renders mid-height', () => {
  // Flat series → norm 0.5 → level 2 → row 1: left 0x02, right 0x10.
  assert.equal(braille([5, 5], 1), '⠒');
});

test('braille: resamples to width*2 columns', () => {
  // 4 samples into 1 cell (2 columns): buckets [0,0]→0 and [1,1]→1.
  assert.equal(braille([0, 0, 1, 1], 1), '⡈');
});

test('braille: invalid width → empty string', () => {
  assert.equal(braille([0, 1], 0), '');
  assert.equal(braille([0, 1], -3), '');
  assert.equal(braille([0, 1], Number.NaN), '');
});

/* ─── tile — 3-row annunciator tile ───────────────────────────────────── */

test('tile: lit tile brackets the centred label with lamp edges', () => {
  assert.deepEqual(tile('GRID', true, 8), ['▁▁▁▁▁▁▁▁', '█ GRID █', '▔▔▔▔▔▔▔▔']);
});

test('tile: dark tile keeps the label in the same columns', () => {
  assert.deepEqual(tile('GRID', false, 8), ['▁▁▁▁▁▁▁▁', '  GRID  ', '▔▔▔▔▔▔▔▔']);
});

test('tile: odd leftover space goes right of the label', () => {
  assert.deepEqual(tile('AC', true, 7), ['▁▁▁▁▁▁▁', '█ AC  █', '▔▔▔▔▔▔▔']);
});

test('tile: overlong label truncates to the inner width', () => {
  assert.deepEqual(tile('OVERLONGLABEL', true, 6), ['▁▁▁▁▁▁', '█OVER█', '▔▔▔▔▔▔']);
});

test('tile: all rows are exactly the requested width', () => {
  for (const w of [1, 2, 3, 6, 13, 40]) {
    for (const lit of [true, false]) {
      const rows = tile('LOAD SHED', lit, w);
      assert.equal(rows.length, 3);
      for (const row of rows) assert.equal(row.length, w, `width=${w} lit=${lit}`);
    }
  }
});

test('tile: degenerate widths stay total', () => {
  assert.deepEqual(tile('X', true, 1), ['▁', '█', '▔']);
  assert.deepEqual(tile('X', false, 2), ['▁▁', '  ', '▔▔']);
  assert.deepEqual(tile('X', true, 0), ['', '', '']);
  assert.deepEqual(tile('X', true, -4), ['', '', '']);
  assert.deepEqual(tile('X', true, Number.NaN), ['', '', '']);
});

/* ─── fracLabel — fixed-width percent readout ─────────────────────────── */

test('fracLabel: right-aligned in exactly 4 characters', () => {
  assert.equal(fracLabel(0), '  0%');
  assert.equal(fracLabel(0.5), ' 50%');
  assert.equal(fracLabel(1), '100%');
});

test('fracLabel: rounds to a whole percent', () => {
  assert.equal(fracLabel(0.499), ' 50%');
  assert.equal(fracLabel(0.004), '  0%');
});

test('fracLabel: clamps NaN/±Infinity/out-of-range', () => {
  assert.equal(fracLabel(Number.NaN), '  0%');
  assert.equal(fracLabel(-1), '  0%');
  assert.equal(fracLabel(2), '100%');
  assert.equal(fracLabel(Infinity), '100%');
  assert.equal(fracLabel(-Infinity), '  0%');
});

test('fracLabel: every output is 4 characters', () => {
  for (let i = 0; i <= 100; i++) {
    assert.equal(fracLabel(i / 100).length, 4);
  }
});
