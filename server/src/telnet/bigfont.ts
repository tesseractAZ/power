/**
 * Block-glyph "big font" — large numeric readouts for the telnet TUI.
 *
 * Renders short numeric strings (SoC percentages, kW figures, clock times)
 * five terminal rows tall, in the same pseudo-LCD language as the brand
 * block on the mode chooser (plant/chooser.ts): glyphs are hand-drawn grids
 * of solid blocks with 2-column strokes, seven-segment-style digits, no
 * external ASCII-art fonts.
 *
 * Deliberately pure string manipulation — no I/O, no ANSI. Colour is applied
 * by callers around whole rendered rows; keeping escape codes out of this
 * module means every character here is a single-cell BMP glyph, so JS
 * .length equals on-screen columns (the same invariant ansi.ts relies on)
 * and callers can pad/centre the rows with the ordinary layout helpers.
 *
 * Coverage is the character set numeric readouts actually need: digits,
 * '.', '-', '+', '%', ':', '/', the unit letters 'k'/'W'/'h', and space.
 * Anything else renders as a space-width blank rather than throwing — a
 * formatter emitting an unexpected character must degrade to a gap in a
 * banner, never take the whole frame down.
 */

/** Rows in every rendered glyph (and in every bigText() result). */
export const BIG_ROWS = 5;

/** Blank columns between adjacent glyphs. */
const GAP = 1;

/*
 * Glyph grids. Each entry is exactly BIG_ROWS strings of one fixed width:
 * digits and letters 5 columns (7 for the intrinsically wide 'W'),
 * punctuation narrower. Only '█' and ' ' are used — half-blocks ('▀'/'▄')
 * would render at half the stroke weight and break the LCD look.
 */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['█████',
        '██ ██',
        '██ ██',
        '██ ██',
        '█████'],
  '1': ['  ██ ',
        ' ███ ',
        '  ██ ',
        '  ██ ',
        ' ████'],
  '2': ['█████',
        '   ██',
        '█████',
        '██   ',
        '█████'],
  '3': ['█████',
        '   ██',
        '█████',
        '   ██',
        '█████'],
  '4': ['██ ██',
        '██ ██',
        '█████',
        '   ██',
        '   ██'],
  '5': ['█████',
        '██   ',
        '█████',
        '   ██',
        '█████'],
  '6': ['█████',
        '██   ',
        '█████',
        '██ ██',
        '█████'],
  '7': ['█████',
        '   ██',
        '   ██',
        '   ██',
        '   ██'],
  '8': ['█████',
        '██ ██',
        '█████',
        '██ ██',
        '█████'],
  '9': ['█████',
        '██ ██',
        '█████',
        '   ██',
        '█████'],
  '.': ['  ',
        '  ',
        '  ',
        '  ',
        '██'],
  ':': ['  ',
        '██',
        '  ',
        '██',
        '  '],
  '-': ['    ',
        '    ',
        '████',
        '    ',
        '    '],
  '+': ['    ',
        ' ██ ',
        '████',
        ' ██ ',
        '    '],
  '%': ['██  █',
        '██ █ ',
        '  █  ',
        ' █ ██',
        '█  ██'],
  '/': ['    █',
        '   █ ',
        '  █  ',
        ' █   ',
        '█    '],
  'k': ['██  █',
        '██ █ ',
        '███  ',
        '██ █ ',
        '██  █'],
  'W': ['██   ██',
        '██   ██',
        '██ █ ██',
        '███ ███',
        ' ██ ██ '],
  'h': ['██   ',
        '██   ',
        '█████',
        '██ ██',
        '██ ██'],
  ' ': ['   ',
        '   ',
        '   ',
        '   ',
        '   '],
};

/** Grid for a character — the space glyph for anything unsupported. */
function glyphFor(ch: string): readonly string[] {
  return GLYPHS[ch] ?? GLYPHS[' '];
}

/**
 * Render `s` as BIG_ROWS strings of equal length (glyphs separated by
 * GAP-column gaps). An empty input yields BIG_ROWS empty strings.
 */
export function bigText(s: string): string[] {
  const rows: string[] = Array.from({ length: BIG_ROWS }, () => '');
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const g = glyphFor(chars[i]);
    const sep = i > 0 ? ' '.repeat(GAP) : '';
    for (let r = 0; r < BIG_ROWS; r++) rows[r] += sep + g[r];
  }
  return rows;
}

/**
 * Visible column width bigText(s) will occupy — lets callers reserve or
 * centre layout space without rendering twice.
 */
export function bigTextWidth(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  let width = GAP * (chars.length - 1);
  for (const ch of chars) width += glyphFor(ch)[0].length;
  return width;
}
