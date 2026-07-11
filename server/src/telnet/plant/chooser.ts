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

  // Top vertical spacing — kept small (not proportional to H) so the whole
  // chooser fits inside a standard 80x24 terminal without scrolling. r28:
  // the previous H*0.10 pad plus a stacked-card layout that ran ~9 rows per
  // wrapped body pushed total content well past row 24 at 80x24 — the very
  // first screen every telnet client sees.
  const topPad = Math.max(1, Math.floor(H * 0.05));
  for (let i = 0; i < topPad; i++) out.push('');

  // Brand block — pseudo-LCD characters built from solid blocks.
  // POWER — keep the lines visually balanced.
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
      sub: 'SCADA · alarms · trends',
      lines: [
        'Tags, alarms, mimic diagram,',
        'trend strips — every point.',
      ],
    },
    {
      key: '2',
      title: 'SUMMARY',
      sub: 'narrative · forecast',
      lines: [
        'Energy flow, today\'s totals,',
        'fleet inventory, forecast.',
      ],
    },
  ];

  // r28: cardW 40→36 and the body copy trimmed to two short lines each so the
  // pair renders SIDE-BY-SIDE (not stacked) at the standard 80-col width:
  // 36*2 + gap(4) + margin(4) = 80. Side-by-side costs the height of ONE
  // card instead of two stacked ones — that's what keeps the whole chooser
  // inside 24 rows. Narrower terminals still fall back to the stacked branch
  // below.
  const cardW = 36;
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

  // Body lines — word-wrap to the inner content width (inner minus the 2-col
  // indent) so long sentences flow to the next line instead of being hard-
  // clipped mid-word at the box wall.
  for (const body of opt.lines) {
    for (const wrapped of wrapText(body, inner - 2)) {
      lines.push(border(BOX.v) + padEnd('  ' + c.grey(wrapped), inner) + border(BOX.v));
    }
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

/**
 * Word-wrap a plain (un-coloured) string to lines no wider than `width`.
 * Mirrors the private helper in ../screens.ts (which isn't exported). An empty
 * input yields a single empty line so paragraph spacers survive the wrap.
 */
function wrapText(s: string, width: number): string[] {
  const w = Math.max(8, width);
  const lines: string[] = [];
  let cur = '';
  for (let word of s.split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      // Hard-break a word that cannot fit on a line by itself.
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Convenience — initial chooser state, defaulting to PLANT OPERATOR. */
export function defaultChooserState(width: number, height: number): ChooserState {
  return { width, height, highlight: 0 };
}

export type { ChooserState };
