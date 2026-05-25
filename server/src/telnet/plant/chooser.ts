/**
 * Mode chooser — first screen the user sees on telnet connect.
 *
 * Two options:
 *   [1]  PLANT OPERATOR — SCADA-style technical console
 *   [2]  SUMMARY         — friendly bird's-eye dashboard (the original UI)
 *
 * Same color/box-drawing language as the Plant interface so the chooser
 * itself feels like the splash screen of an industrial workstation. The
 * brand "block" at the top is built from box-drawing characters; no
 * external ASCII-art fonts.
 */

import { c, padEnd, center, BOX } from '../ansi.js';

interface ChooserState {
  width: number;
  height: number;
  /** Highlighted option (0-based). Arrow keys move it, Enter selects. */
  highlight: 0 | 1;
}

export function renderChooser(s: ChooserState): string[] {
  const W = Math.max(60, s.width);
  const H = Math.max(20, s.height);
  const out: string[] = [];

  // Top vertical spacing — push the brand block toward the upper third.
  const topPad = Math.max(1, Math.floor(H * 0.10));
  for (let i = 0; i < topPad; i++) out.push('');

  // Brand block — pseudo-LCD characters built from solid blocks.
  // ECOFLOW PANEL — keep the lines visually balanced.
  const brand = [
    '███████  ██████   ██████  ███████ ██       ██████  ██     ██   ',
    '██      ██       ██    ██ ██      ██      ██    ██ ██     ██   ',
    '█████   ██       ██    ██ █████   ██      ██    ██ ██  █  ██   ',
    '██      ██       ██    ██ ██      ██      ██    ██ ██ ███ ██   ',
    '███████  ██████   ██████  ██      ███████  ██████   ███ ███    ',
  ];
  for (const line of brand) {
    out.push(center(c.cyanB(line), W));
  }
  out.push('');
  out.push(center(c.dim('P L A N T   C O N T R O L   S T A T I O N'), W));
  out.push('');

  // Description line.
  out.push(center(c.grey('Select an operator console:'), W));
  out.push('');

  // The two option cards, side-by-side if wide enough, stacked otherwise.
  const opts: Array<{ key: string; title: string; lines: string[]; sub: string }> = [
    {
      key: '1',
      title: 'PLANT OPERATOR',
      sub: 'SCADA · gauges · alarms · trends',
      lines: [
        'Technical control-room console.',
        'Tag-based instrumentation, alarm',
        'banner, mimic flow diagram, per-',
        'circuit feeders, trend strips, and',
        'live point quality flags.',
        '',
        'Designed for the operator who wants',
        'every number and the state of every',
        'switch on one screen.',
      ],
    },
    {
      key: '2',
      title: 'SUMMARY',
      sub: 'narrative · headlines · forecast',
      lines: [
        'Friendly bird\'s-eye dashboard.',
        'Energy flow, today\'s totals, fleet',
        'inventory, day-ahead forecast, and',
        'cleanly-formatted device cards.',
        '',
        'The original UI — best when you',
        'want a quick read of "how are',
        'we doing?" rather than every',
        'measurement.',
      ],
    },
  ];

  const cardW = 38;
  const gap = 4;
  const sideBySide = W >= cardW * 2 + gap + 4;

  if (sideBySide) {
    const totalW = cardW * 2 + gap;
    const sideMargin = Math.max(0, Math.floor((W - totalW) / 2));
    const card = (i: 0 | 1) => optionCard(opts[i], cardW, s.highlight === i);
    const left = card(0);
    const right = card(1);
    const rows = Math.max(left.length, right.length);
    for (let r = 0; r < rows; r++) {
      const l = left[r] ?? padEnd('', cardW);
      const rr = right[r] ?? padEnd('', cardW);
      out.push(' '.repeat(sideMargin) + l + ' '.repeat(gap) + rr);
    }
  } else {
    const sideMargin = Math.max(0, Math.floor((W - cardW) / 2));
    for (const o of opts) {
      const lines = optionCard(o, cardW, s.highlight === (o.key === '1' ? 0 : 1));
      for (const ln of lines) out.push(' '.repeat(sideMargin) + ln);
      out.push('');
    }
  }

  out.push('');
  out.push(center(
    c.grey('Press ') + c.cyanB('1') + c.grey(' or ') + c.cyanB('2') +
    c.grey(' · ') + c.cyanB('←/→') + c.grey(' to highlight · ') +
    c.cyanB('ENTER') + c.grey(' to select · ') +
    c.cyanB('Q') + c.grey(' to quit'), W));

  return out;
}

function optionCard(
  opt: { key: string; title: string; lines: string[]; sub: string },
  width: number,
  highlighted: boolean,
): string[] {
  const inner = width - 2;
  const border = highlighted ? c.cyanB : c.cyan;
  const top = border(BOX.tl + BOX.h.repeat(inner) + BOX.tr);
  const bot = border(BOX.bl + BOX.h.repeat(inner) + BOX.br);

  const lines: string[] = [];
  lines.push(top);

  // Title bar: [ 1 ]  PLANT OPERATOR
  const keyBox = c.cyanB('[ ') + c.whiteB(opt.key) + c.cyanB(' ]');
  const titleStyled = highlighted ? c.whiteB(opt.title) : c.white(opt.title);
  const titleLine = '  ' + keyBox + '  ' + titleStyled;
  lines.push(border(BOX.v) + padEnd(titleLine, inner) + border(BOX.v));

  // Subtitle.
  lines.push(border(BOX.v) + padEnd('  ' + c.grey(opt.sub), inner) + border(BOX.v));

  // Rule.
  lines.push(border(BOX.v) + c.grey(' '.repeat(2) + '─'.repeat(inner - 4) + '  ') + border(BOX.v));

  // Body lines.
  for (const body of opt.lines) {
    lines.push(border(BOX.v) + padEnd('  ' + c.grey(body), inner) + border(BOX.v));
  }
  // Indicator at bottom if highlighted.
  if (highlighted) {
    lines.push(border(BOX.v) + padEnd('  ' + c.cyanB('▶ press ENTER to enter'), inner) + border(BOX.v));
  } else {
    lines.push(border(BOX.v) + padEnd('', inner) + border(BOX.v));
  }
  lines.push(bot);
  return lines;
}

/** Convenience — initial chooser state, defaulting to PLANT OPERATOR. */
export function defaultChooserState(width: number, height: number): ChooserState {
  return { width, height, highlight: 0 };
}

export type { ChooserState };
