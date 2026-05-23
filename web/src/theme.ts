/**
 * Color theme for charts and SVG (recharts needs literal color strings, so it
 * can't read Tailwind classes). Mirror of the tokens in tailwind.config.js —
 * a light industrial HMI / control-room palette.
 */
export const UI = {
  bg: '#c2c8d0',
  panel: '#eef0f3',
  panel2: '#dfe3e8',
  line: '#9aa3b0',
  ink: '#1b2027',
  muted: '#586474',
  accent: '#0e7490',
  ok: '#15803d',
  warn: '#b45309',
  bad: '#b91c1c',
} as const;

/** Structural chart colors (gridlines, axes, tooltip). */
export const CHART = {
  grid: '#c4cad3',
  axis: UI.muted,
  tooltipBg: '#ffffff',
  tooltipBorder: UI.line,
} as const;

/** Semantic series hues, tuned to read on a light panel. */
export const HUES = {
  solar: '#d97706', // amber-600
  battery: '#0e7490', // cyan-700
  load: '#0f766e', // teal-700
  soc: '#15803d', // green-700
  grid: '#586474', // grey
  violet: '#7c3aed',
  pink: '#db2777',
  amber: '#b45309',
} as const;

/** Palette for multi-series charts (per-DPU / per-string lines). */
export const SERIES_PALETTE = ['#0e7490', '#15803d', '#b45309', '#7c3aed', '#db2777', '#0f766e'];
