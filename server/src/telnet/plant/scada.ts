/**
 * SCADA / HMI primitives for the Plant Operator interface.
 *
 * The visual language here is borrowed from real industrial control rooms —
 * specifically power-grid SCADA (GE iFIX, ABB Symphony, Inductive Automation
 * Ignition), marine engine control rooms (Kongsberg K-Chief, Wärtsilä WMU),
 * and oil-rig HMIs (Honeywell Experion, Yokogawa CENTUM VP).
 *
 * Conventions a real plant operator expects on sight:
 *
 *   - Tag-based identifiers (`BUS.MAIN.V`, `GEN.1.P`, `LD.CH22.A`) — never
 *     prose. Every measurable point gets a tag, every tag gets one line.
 *   - Strict color discipline:
 *       GREEN  = in-service, value within band, no action needed
 *       WHITE  = unqualified numeric value
 *       YELLOW = warning band, attention required
 *       RED    = alarm / trip / out-of-band, immediate action
 *       CYAN   = manual / bypassed / locked-out / under maintenance
 *       MAGENTA= communication failure with the field device
 *       GREY   = out-of-service / not configured
 *   - Quality bits per tag (G/S/B/U) — distinguishes a measured 0 from
 *     a stale cache from a comm failure.
 *   - Status flags per device (A/M=Auto/Manual, L/R=Local/Remote,
 *     O/C=Open/Closed, N/W/A/T=Normal/Warn/Alarm/Trip).
 *   - Alarm banner with newest unack'd + count by severity, blinking on
 *     critical conditions (we simulate blinking with bright/dim alternation).
 *   - Trend strips — 8-character mini-sparklines straight off any modern
 *     HMI tag faceplate.
 *
 * Everything is visible-width aware, ANSI-stripping safe, and 80-col friendly.
 */

import { c, padEnd, padStart, truncate, visLen, BOX } from '../ansi.js';
// v0.11.0 — the alarm banner is keyed on the 4-tier ISA-18.2 / IEC 62682
// priority (Critical/High/Medium/Low) instead of the raw severity.
import { type AlarmPriority } from '../../alertPriority.js';

/** ANSI colourizer for an ISA priority. No orange in the 16-colour palette, so
 *  High shares Critical's bright-red; Medium = bright-yellow; Low = cyan. */
function prioColor(p: AlarmPriority): (s: string) => string {
  return p === 'critical' ? c.redB : p === 'high' ? c.redB : p === 'medium' ? c.yellowB : c.cyan;
}

/* ─── color discipline ────────────────────────────────────────────────── */

/** SCADA alarm state — the universal vocabulary across every HMI vendor. */
export type AlarmState =
  | 'normal'   // in-service, value within band
  | 'warn'     // warning band, advisory
  | 'alarm'    // alarm band, action required
  | 'trip'     // tripped / fault / out-of-service
  | 'manual'   // operator-bypassed
  | 'comm'     // comm failure to the device
  | 'oos';     // out of service / disabled

const STATE_COLOR: Record<AlarmState, (s: string) => string> = {
  normal: c.green,
  warn:   c.yellow,
  alarm:  c.red,
  trip:   c.redB,
  manual: c.cyan,
  comm:   (s) => `\x1b[95m${s}\x1b[0m`,  // bright magenta
  oos:    c.grey,
};

const STATE_GLYPH: Record<AlarmState, string> = {
  normal: '●',
  warn:   '▲',
  alarm:  '■',
  trip:   '✕',
  manual: '◆',
  comm:   '◌',
  oos:    '○',
};

export function stateText(state: AlarmState, text: string): string {
  return STATE_COLOR[state](text);
}
export function stateGlyph(state: AlarmState): string {
  return STATE_COLOR[state](STATE_GLYPH[state]);
}

/* ─── quality flags ───────────────────────────────────────────────────── */

/** Tag value quality — distinguishes good reads from stale/bad/uncertain. */
export type Quality = 'good' | 'stale' | 'bad' | 'uncertain';

export function qualityChar(q: Quality): string {
  switch (q) {
    case 'good':      return c.green('G');
    case 'stale':     return c.yellow('S');
    case 'bad':       return c.red('B');
    case 'uncertain': return c.cyan('U');
  }
}

/** Pick a quality based on age of the underlying sample. */
export function ageQuality(ageMs: number | null | undefined): Quality {
  if (ageMs == null) return 'bad';
  if (ageMs < 30_000) return 'good';
  if (ageMs < 180_000) return 'stale';
  return 'bad';
}

/* ─── tag row — the atomic unit of the SCADA display ──────────────────── */

export interface TagRow {
  /** Hierarchical tag identifier, e.g. "BUS.MAIN.V" or "GEN.1.SOC". */
  tag: string;
  /** Numeric value as a string, already formatted to display precision. */
  value: string;
  /** Engineering unit. Empty string if dimensionless. */
  unit: string;
  /** Alarm/normality state — drives color. */
  state: AlarmState;
  /** Quality flag — G/S/B/U. */
  quality?: Quality;
  /** Status flag string (e.g. "A/L/N" for Auto/Local/Normal). */
  flags?: string;
  /** Optional inline mini-trend (8 chars). */
  trend?: string;
  /** Optional 1-line description for label column. */
  description?: string;
}

/**
 * Render a SCADA tag row with this column layout (80-col):
 *
 *   ●  TAG.NAME.HERE..................   123.4 kW  G  A/L/N  ▁▂▃▄▅▆▇█
 *   │  │                                 │     │   │  │      │
 *   │  └─ tag (max 30, dot-padded)       │     │   │  │      └─ trend (8)
 *   │                                    │     │   │  └─ flags (8 wide)
 *   └─ state glyph                       │     │   └─ quality (1)
 *                                        │     └─ unit (4)
 *                                        └─ value (right-justified, 9)
 */
export function renderTagRow(row: TagRow, widthCols: number): string {
  const glyph = stateGlyph(row.state);                          // 1 char visible
  const tagText = c.whiteB(row.tag);                            // bright white tag
  // Dot-leader padding from end of tag to start of value column.
  const tagBoxW = 32;
  const tagPadded = padDotLeader(tagText, row.tag, tagBoxW);
  const valStr = STATE_COLOR[row.state](padStart(row.value, 9));
  const unitStr = c.grey(padEnd(row.unit, 4));
  const qStr = row.quality ? qualityChar(row.quality) : ' ';
  const flagsStr = c.grey(padEnd(row.flags ?? '', 8));
  const trendStr = row.trend ? c.cyan(row.trend) : ' '.repeat(8);

  const base = `${glyph}  ${tagPadded} ${valStr} ${unitStr} ${qStr}  ${flagsStr} ${trendStr}`;
  // Pad/truncate to fit narrower terminals gracefully.
  return widthCols > 0 ? padEnd(base, widthCols) : base;
}

/**
 * Render a tag row when no value is available (no telemetry, comm down).
 * Same column layout but everything dim/grey to emphasize absence.
 */
export function renderTagRowNoData(tag: string, reason: string, widthCols: number): string {
  const glyph = stateGlyph('comm');
  const tagPadded = padDotLeader(c.grey(tag), tag, 32);
  const reasonStr = c.grey(padEnd(`—  ${reason}`, 9 + 1 + 4 + 1 + 1 + 2 + 8 + 1 + 8));
  return widthCols > 0 ? padEnd(`${glyph}  ${tagPadded} ${reasonStr}`, widthCols) : `${glyph}  ${tagPadded} ${reasonStr}`;
}

/** Pad a (possibly ANSI-styled) tag with grey dots out to width. */
function padDotLeader(styled: string, plain: string, widthCols: number): string {
  const remaining = widthCols - plain.length;
  if (remaining <= 0) return truncate(styled, widthCols);
  return styled + c.grey('.'.repeat(remaining));
}

/* ─── analog gauge — for SOC, capacity, load percent ──────────────────── */

/**
 * Horizontal bar gauge with banded color zones — green good, yellow caution,
 * red alarm. Marker pip shows current value over the band.
 *
 * Example for SOC band (red <20, yellow <50, green ≥50):
 *
 *   ░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░ 67.4%
 *
 * The pip is rendered atop the colored band so the operator sees both the
 * absolute value and its position within the operating envelope.
 */
export function bandedGauge(
  pct: number,
  bands: { red: number; yellow: number },   // upper bounds for the lower zones
  width: number,
  invert = false,    // if true, low = good (inverse logic e.g. for temperature)
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filledChars = Math.round((clamped / 100) * width);
  let out = '';
  for (let i = 0; i < width; i++) {
    const cellPct = ((i + 0.5) / width) * 100;
    let color: (s: string) => string;
    if (invert) {
      color = cellPct >= 100 - bands.red ? c.red : cellPct >= 100 - bands.yellow ? c.yellow : c.green;
    } else {
      color = cellPct < bands.red ? c.red : cellPct < bands.yellow ? c.yellow : c.green;
    }
    out += i < filledChars ? color('█') : c.grey('░');
  }
  return out;
}

/** Simple monochrome gauge — single color across the whole bar. */
export function gauge(
  pct: number,
  width: number,
  color: 'green' | 'yellow' | 'red' | 'cyan' = 'green',
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const paint = c[color];
  return paint('█'.repeat(filled)) + c.grey('░'.repeat(Math.max(0, width - filled)));
}

/* ─── trend strip — last-N-samples mini-sparkline ─────────────────────── */

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a sparkline from a series of numeric samples. Auto-scales to
 * min/max across the input. Returns exactly `width` characters.
 */

/* ─── deviation displays — for frequency, voltage, set-point bias ─────── */

/**
 * Render a value with a delta from a setpoint, in the style of a frequency
 * meter on a power-plant console:
 *
 *   59.98 Hz   Δ -0.02
 *
 * The delta is colored by deviation magnitude (band warn/alarm passed in).
 */
export function deviationDisplay(
  value: number,
  setpoint: number,
  unit: string,
  precision = 2,
  bands: { warn: number; alarm: number } = { warn: 0.1, alarm: 0.5 },
): string {
  const delta = value - setpoint;
  const adelta = Math.abs(delta);
  const color = adelta >= bands.alarm ? c.red : adelta >= bands.warn ? c.yellow : c.green;
  const sign = delta >= 0 ? '+' : '−';
  const valStr = c.whiteB(`${value.toFixed(precision)} ${unit}`);
  const dStr = color(`Δ ${sign}${adelta.toFixed(precision)}`);
  return `${valStr}  ${dStr}`;
}

/* ─── section divider — like a control-room panel break ───────────────── */

/**
 * Render a labeled divider line — looks like a panel separator on an
 * old-school control board:
 *
 *   ╞════════════[ MAIN BUS — 240 V ]════════════════════════════════════╡
 *
 * Returns ONE line padded to `width`.
 */
export function divider(label: string, width: number): string {
  const inner = ` ${label} `;
  const leftPad = 6;
  const left = BOX.lJoint + BOX.h.repeat(leftPad);
  // Build the right side so the total visible width = `width`.
  const rest = width - visLen(left) - inner.length - 1;
  const right = BOX.h.repeat(Math.max(0, rest)) + BOX.rJoint;
  return c.cyan(left) + c.cyanB(inner) + c.cyan(right);
}

/** Plain rule line at the requested width. */
export function rule(width: number): string {
  return c.grey('─'.repeat(width));
}

/* ─── alarm banner — top-of-screen alarm summary ─────────────────────── */

export interface AlarmBannerInput {
  newest: { ts: number; text: string; priority: AlarmPriority } | null;
  counts: Record<AlarmPriority, number>;
  ackCount: number;
}

/** Three-letter banner tag per priority — the "ALM/WRN/INF" of the 4-tier scheme. */
function bannerTag(p: AlarmPriority): string {
  return p === 'critical' ? 'ALM' : p === 'high' ? 'HI ' : p === 'medium' ? 'MED' : 'LOW';
}

/**
 * Render the alarm-banner strip — fits one line. Newest unack'd alarm
 * dominates the message area; counts shown right-justified.
 *
 *   ▌▌ALM 14:32:17  GEN.3.PACK.4.T HIGH  157°F      CRIT:1 HIGH:2 MED:3 ACK:0 ▌▌
 */
export function alarmBanner(input: AlarmBannerInput, width: number): string {
  const { newest, counts, ackCount } = input;
  let leftCol: string;
  if (newest) {
    const ts = new Date(newest.ts);
    const tstr = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
    const tag = prioColor(newest.priority)(bannerTag(newest.priority));
    leftCol = `${c.redB('▌▌')} ${tag} ${c.grey(tstr)}  ${c.white(newest.text)}`;
  } else {
    leftCol = `${c.green('▌▌')} ${c.greenB('NORMAL')} ${c.grey('—  no active alarms')}`;
  }
  const rightSegs: string[] = [];
  if (counts.critical > 0) rightSegs.push(prioColor('critical')(`CRIT:${counts.critical}`));
  if (counts.high > 0)     rightSegs.push(prioColor('high')(`HIGH:${counts.high}`));
  if (counts.medium > 0)   rightSegs.push(prioColor('medium')(`MED:${counts.medium}`));
  if (counts.low > 0)      rightSegs.push(prioColor('low')(`LOW:${counts.low}`));
  rightSegs.push(c.grey(`ACK:${ackCount}`));
  const rightCol = rightSegs.join(' ');

  const gap = width - visLen(leftCol) - visLen(rightCol);
  if (gap < 1) return truncate(leftCol, width);
  return leftCol + ' '.repeat(gap) + rightCol;
}

/* ─── status panel header — TIMESTAMP | UPTIME | MODE | STATION ──────── */

export interface StatusHeader {
  station: string;
  mode: string;        // e.g. "ISLANDED" / "GRID-TIED" / "TRANSFER"
  modeState: AlarmState;
  uptime: string;      // pre-formatted
  operator?: string;   // optional operator/seat name
}

export function statusHeader(h: StatusHeader, width: number): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // Compressed to date + HH:MM (was HH:MM:SS) — dropping seconds reclaims the
  // 3 cols that previously pushed the MODE value off the 80-col line.
  const ts = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;

  // Tightened separators (was "  │  ", 5 cols → " │ ", 3 cols) and dropped the
  // redundant "TS " label so the full line fits in 80 with the MODE value intact.
  const tsPart = c.grey(' │ ') + c.white(ts);   // " │ 2026-…"
  const mid = c.grey('UP ') + c.white(h.uptime);
  // MODE leads the right segment so the operator always sees ISLANDED vs
  // GRID-TIED — at 80 cols it must never be the truncated tail. The OPR seat
  // is low-value and trails MODE, so it (not MODE) is the first thing to go.
  const right =
    c.grey('MODE ') + STATE_COLOR[h.modeState](h.mode) +
    (h.operator ? c.grey(' │ OPR ') + c.white(h.operator) : '');

  // Priority: the right block (UP + MODE) and the timestamp are kept intact;
  // only the station label is shortened if the line would overrun `width`.
  const rightBlock = mid + '  ' + right;            // "UP …   MODE …"
  const fixedW = 2 /*▎ + space*/ + visLen(tsPart) + 2 /*min gap*/ + visLen(rightBlock);
  const stationBudget = width - fixedW;
  if (stationBudget < 1) {
    // Pathological narrow terminal — keep MODE, drop the rest.
    return truncate(right, width);
  }
  const stationFit = h.station.length <= stationBudget
    ? h.station
    : truncate(h.station, stationBudget);
  const left = c.cyanB('▎') + c.whiteB(' ' + stationFit) + tsPart;
  const gap = Math.max(2, width - visLen(left) - visLen(rightBlock));
  return left + ' '.repeat(gap) + rightBlock;
}

/* ─── footer — hotkey legend with current screen highlighted ──────────── */

export interface FooterTab {
  key: string;
  short: string;
  active: boolean;
}

export function footerLegend(tabs: FooterTab[], extra: string, width: number): string {
  const tabStrs = tabs.map((t) =>
    c.cyanB(t.key) + ' ' + (t.active ? c.invert(' ' + t.short + ' ') : c.grey(t.short)),
  );
  const left = tabStrs.join('  ');
  const right = extra;
  const gap = width - visLen(left) - visLen(right);
  if (gap < 1) return truncate(left + ' ' + right, width);
  return left + ' '.repeat(gap) + right;
}

/* ─── mimic helpers — box-drawing for power-flow diagrams ─────────────── */

/** Box characters tuned for HMI-style mimic diagrams. */
export const MIMIC = {
  // Single-line for instrumentation boxes
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  // Double-line for primary equipment (generators, transformers, buses)
  dtl: '╔', dtr: '╗', dbl: '╚', dbr: '╝',
  dh: '═', dv: '║',
  // Junction characters
  cross: '┼', tDown: '┬', tUp: '┴', tRight: '├', tLeft: '┤',
  // Heavy bus bar
  bus: '━',
  // Power-flow arrows
  arrowR: '►', arrowL: '◄', arrowU: '▲', arrowD: '▼',
  // Equipment glyphs
  battery: '▮', solar: '☀', breaker: '◧', motor: '⊙', meter: '⏱',
};

/**
 * Render a small equipment box — label on top, value inside, status glyph
 * in the bottom-right corner. Returns 3 lines.
 *
 *   ┌─ GEN 1 ─────┐
 *   │  +2.4 kW    │
 *   │ SOC 87%   ● │
 *   └─────────────┘
 *
 * In practice we go cheaper than this — see `equipmentBlock`.
 */
export function equipmentBlock(label: string, value: string, sub: string, state: AlarmState, width: number): string[] {
  const inner = width - 2;
  const top = c.cyan(MIMIC.tl + MIMIC.h + ' ' + label + ' ' + MIMIC.h.repeat(Math.max(0, inner - label.length - 4)) + MIMIC.tr);
  const mid = c.cyan(MIMIC.v) + ' ' + padEnd(STATE_COLOR[state](value), inner - 1) + c.cyan(MIMIC.v);
  const bot = c.cyan(MIMIC.bl + padEnd(' ' + c.grey(sub) + '  ' + stateGlyph(state), inner) + MIMIC.br);
  return [top, mid, bot];
}

/** Bus-bar segment — a chunk of double-line representing the main bus. */
export function busBarSegment(label: string, width: number): string {
  const inner = ` ${label} `;
  const each = Math.max(2, Math.floor((width - inner.length) / 2));
  return c.cyanB(MIMIC.dh.repeat(each) + inner + MIMIC.dh.repeat(width - each - inner.length));
}
