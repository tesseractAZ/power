/**
 * High-resolution gauge primitives for the telnet TUI.
 *
 * Sub-cell rendering on top of the plain block meters in `ansi.ts` /
 * `plant/scada.ts`:
 *
 *   - `hbar`    — horizontal bar with eighth-block resolution (width×8 steps)
 *   - `vscale`  — one-row column chart with eighth-height resolution
 *   - `braille` — one-row braille sparkline, 2 columns × 4 levels per cell
 *   - `tile`    — 3-row ISA-annunciator legend tile
 *   - `fracLabel` — fixed-width percent label to sit beside a bar
 *
 * Everything here is a pure string function: no ANSI codes (callers colorize
 * whole segments), no clock, no randomness. Every function is total —
 * non-finite fractions/values clamp to sane bounds, non-finite or
 * non-positive widths render empty — so a bad telemetry sample can never
 * throw mid-frame. Only BMP single-cell glyphs are emitted, so JS string
 * .length matches on-screen columns.
 */

/* ─── clamping / width policy ─────────────────────────────────────────── */

/** Clamp to [0,1]; NaN and −Infinity → 0, +Infinity → 1. */
function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

/** Usable column count: positive finite widths floor to an integer, anything
 *  else (0, negative, NaN, ±Infinity) → 0, which renders as ''. */
function cols(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}

/* ─── hbar — eighth-block horizontal bar ──────────────────────────────── */

/** Left-to-right partial-fill ramp; index = eighths filled (0..8). */
const EIGHTH_H = ' ▏▎▍▌▋▊▉█';

/**
 * Horizontal bar with eighth-block resolution: full '█' cells plus at most
 * one partial cell, space-padded to exactly `width` characters. `frac` is
 * clamped to [0,1]; resolution is width×8 steps (nearest step wins).
 *
 *   hbar(0.5, 4)  → '██  '
 *   hbar(1/16, 2) → '▏ '
 */
export function hbar(frac: number, width: number): string {
  const w = cols(width);
  if (w === 0) return '';
  const steps = Math.round(clamp01(frac) * w * 8);
  const full = Math.floor(steps / 8);
  const rem = steps % 8;
  if (full >= w) return '█'.repeat(w);
  return '█'.repeat(full) + (rem > 0 ? EIGHTH_H[rem] : '') + ' '.repeat(w - full - (rem > 0 ? 1 : 0));
}

/* ─── shared series plumbing — resample + range ───────────────────────── */

/**
 * Resample a series to exactly `columns` buckets. Each output column is the
 * mean of its proportional share of the input (a shorter-than-width series
 * repeats samples; a longer one averages). Nulls and non-finite samples are
 * skipped inside a bucket; a bucket with no usable sample is null.
 */
function resample(values: Array<number | null>, columns: number): Array<number | null> {
  const n = values.length;
  const out: Array<number | null> = new Array(columns).fill(null);
  if (n === 0) return out;
  for (let i = 0; i < columns; i++) {
    const a = Math.floor((i * n) / columns);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / columns));
    let sum = 0;
    let count = 0;
    for (let j = a; j < b && j < n; j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count > 0) out[i] = sum / count;
  }
  return out;
}

/**
 * Normalize resampled columns to [0,1]. Bounds come from the caller when
 * finite, otherwise auto-range over the non-null column means. A degenerate
 * range (hi ≤ lo, or no usable data next to an explicit bound) pins every
 * non-null column to 0.5 — rendered mid-height so a flat line stays visible.
 * Out-of-range values clamp to the nearest bound.
 */
function normalize(columns: Array<number | null>, min?: number, max?: number): Array<number | null> {
  // A non-finite explicit bound is treated as omitted.
  const autoLo = min === undefined || !Number.isFinite(min);
  const autoHi = max === undefined || !Number.isFinite(max);
  let lo = autoLo ? Infinity : (min as number);
  let hi = autoHi ? -Infinity : (max as number);
  if (autoLo || autoHi) {
    for (const v of columns) {
      if (v === null) continue;
      if (autoLo && v < lo) lo = v;
      if (autoHi && v > hi) hi = v;
    }
  }
  const span = hi - lo;
  return columns.map((v) => {
    if (v === null) return null;
    if (!Number.isFinite(span) || span <= 0) return 0.5;
    return clamp01((v - lo) / span);
  });
}

/* ─── vscale — eighth-height column chart ─────────────────────────────── */

/** Bottom-up fill ramp; index = eighths of cell height (0..8). */
const EIGHTH_V = ' ▁▂▃▄▅▆▇█';

/**
 * One-row column chart with eighth-height resolution. The series is
 * resampled to `width` columns (bucket mean, nulls skipped); an all-null
 * bucket renders ' '. Bounds auto-range from the data when omitted; a
 * degenerate range renders every non-null column mid-height ('▄').
 *
 *   vscale([0,1,2,3,4,5,6,7,8], 9) → ' ▁▂▃▄▅▆▇█'
 */
export function vscale(values: Array<number | null>, width: number, min?: number, max?: number): string {
  const w = cols(width);
  if (w === 0) return '';
  const norm = normalize(resample(values, w), min, max);
  let out = '';
  for (const v of norm) {
    out += v === null ? ' ' : EIGHTH_V[Math.round(v * 8)];
  }
  return out;
}

/* ─── braille — 2×4 dot sparkline ─────────────────────────────────────── */

// Braille cell bit layout (offsets from U+2800), column-major:
// left column top→bottom = dots 1,2,3,7 (bits 0,1,2,6); right column
// top→bottom = dots 4,5,6,8 (bits 3,4,5,7). Indexed here by row (0 = top).
const BRAILLE_LEFT = [0x01, 0x02, 0x04, 0x40];
const BRAILLE_RIGHT = [0x08, 0x10, 0x20, 0x80];
const BRAILLE_BASE = 0x2800;

/**
 * One-row braille sparkline: each output character is a 2-column braille
 * cell with one dot per column at one of 4 vertical levels — double the
 * horizontal and half-cell vertical resolution of `vscale`, better suited
 * to trend strips. The series is resampled to width×2 columns (bucket mean,
 * nulls skipped); a null column carries no dot (an all-null cell is the
 * blank braille cell U+2800, which still occupies its column). Bounds
 * auto-range from the data when omitted; a degenerate range renders
 * mid-height.
 *
 *   braille([0,1], 1) → '⡈' (U+2848: low-left dot, high-right dot)
 */
export function braille(values: Array<number | null>, width: number, min?: number, max?: number): string {
  const w = cols(width);
  if (w === 0) return '';
  const norm = normalize(resample(values, w * 2), min, max);
  let out = '';
  for (let i = 0; i < w; i++) {
    let mask = 0;
    const left = norm[2 * i];
    const right = norm[2 * i + 1];
    // Level 0 = bottom row (row 3), level 3 = top row (row 0).
    if (left !== null) mask |= BRAILLE_LEFT[3 - Math.round(left * 3)];
    if (right !== null) mask |= BRAILLE_RIGHT[3 - Math.round(right * 3)];
    out += String.fromCharCode(BRAILLE_BASE | mask);
  }
  return out;
}

/* ─── tile — 3-row ISA annunciator legend tile ────────────────────────── */

/**
 * A 3-row annunciator tile in the style of an ISA-18.1 lamp-box panel: a
 * tight top rule of '▁', the legend line, and a bottom rule of '▔'. When
 * `lit` the legend row is bracketed by '█' lamp-edge marks; when dark the
 * edges are spaces so the legend stays in the same column either way.
 * All three rows are exactly `width` characters. The label is plain text —
 * centered, truncated to fit — and callers colorize whole rows.
 *
 *   tile('GRID', true, 8) → [ '▁▁▁▁▁▁▁▁',
 *                             '█ GRID █',
 *                             '▔▔▔▔▔▔▔▔' ]
 */
export function tile(label: string, lit: boolean, width: number): string[] {
  const w = cols(width);
  if (w === 0) return ['', '', ''];
  const edge = lit ? '█' : ' ';
  let mid: string;
  if (w === 1) {
    mid = edge;
  } else {
    const inner = w - 2;
    const text = label.slice(0, inner);
    const leftPad = Math.floor((inner - text.length) / 2);
    mid = edge + ' '.repeat(leftPad) + text + ' '.repeat(inner - text.length - leftPad) + edge;
  }
  return ['▁'.repeat(w), mid, '▔'.repeat(w)];
}

/* ─── fracLabel — fixed-width percent readout ─────────────────────────── */

/**
 * Percent label for the end of a bar, always exactly 4 characters:
 * '  0%' .. '100%' (value right-aligned). `frac` is clamped to [0,1] and
 * rounded to a whole percent.
 */
export function fracLabel(frac: number): string {
  return String(Math.round(clamp01(frac) * 100)).padStart(3, ' ') + '%';
}
