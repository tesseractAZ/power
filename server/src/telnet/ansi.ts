/**
 * ANSI terminal primitives for the telnet control-room TUI.
 *
 * Everything here is "visible-width aware": colour escape codes do not count
 * toward layout width, so padding/truncation stays correct after styling.
 * Only BMP single-cell glyphs are used (box-drawing, geometric shapes), so
 * JS string .length matches on-screen columns.
 */

export const ESC = '\x1b';
export const RESET = `${ESC}[0m`;

// Cursor / screen control
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const CLEAR_SCREEN = `${ESC}[2J`;
export const CURSOR_HOME = `${ESC}[H`;
export const CLEAR_EOL = `${ESC}[K`;
export const CLEAR_BELOW = `${ESC}[J`;

// v0.9.5 — alt screen buffer + synchronous output mode. Without these the
// TUI was glitching: partial frames from a previous redraw would leak in
// when a key/NAWS event triggered an extra draw mid-render, and leftover
// content from a wider previous frame would peek through on resize.
//
// `?1049h` puts the terminal in the "alternate screen" — separate from the
// user's scrollback, so our redraws can't smear into earlier output, and
// returning to the primary screen on disconnect cleanly restores whatever
// they had visible before connecting.
//
// `?2026h`...`?2026l` is the standard synchronized-update sequence (Kitty,
// iTerm2, Alacritty, WezTerm, recent VTE). The terminal queues output
// between the bracketing escapes and renders one atomic frame at `2026l`
// — eliminating the "characters appearing during refresh" artifacts. On
// terminals that don't recognize it the sequences are silently consumed
// (they don't render as visible bytes).
export const ENTER_ALT_BUFFER = `${ESC}[?1049h`;
export const EXIT_ALT_BUFFER = `${ESC}[?1049l`;
export const BEGIN_SYNC = `${ESC}[?2026h`;
export const END_SYNC = `${ESC}[?2026l`;

function sgr(codes: number[], s: string): string {
  return `${ESC}[${codes.join(';')}m${s}${RESET}`;
}

/** Atomic styled spans — do not nest (the inner RESET would clear the outer). */
export const c = {
  bold: (s: string) => sgr([1], s),
  dim: (s: string) => sgr([2], s),
  red: (s: string) => sgr([91], s),
  green: (s: string) => sgr([92], s),
  yellow: (s: string) => sgr([93], s),
  blue: (s: string) => sgr([94], s),
  cyan: (s: string) => sgr([96], s),
  white: (s: string) => sgr([97], s),
  grey: (s: string) => sgr([90], s),
  redB: (s: string) => sgr([1, 91], s),
  greenB: (s: string) => sgr([1, 92], s),
  yellowB: (s: string) => sgr([1, 93], s),
  cyanB: (s: string) => sgr([1, 96], s),
  whiteB: (s: string) => sgr([1, 97], s),
  /** Inverse video — used for the selected menu tab / row. */
  invert: (s: string) => sgr([7], s),
  /** Dim cyan on default — section labels. */
  label: (s: string) => sgr([96], s),
};

/** Double-line frame (heavy control-room border) + light internal rules. */
export const BOX = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝',
  h: '═', v: '║',
  lJoint: '╠', rJoint: '╣',
  lh: '─', lv: '│',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/*
 * v1.47.2 (second-pass) — display-width-aware column math. The original
 * contract ("only BMP single-cell glyphs are used, so .length matches
 * on-screen columns") holds for everything the add-on generates, but NOT for
 * data-carried strings: EcoFlow device names and SHP2 circuit names are
 * user-set in the EcoFlow app and pass sanitizeDisplayName untouched when
 * they contain CJK or emoji — each rendering 2 terminal columns while
 * counting 1, smearing every aligned layout that shows the name. Column
 * width is now computed per code point: East Asian Wide/Fullwidth and emoji
 * count 2, combining marks count 0, everything else 1. The ASCII fast path
 * keeps the hot render loop at its previous cost.
 */
function charWidth(cp: number): number {
  // Zero-width first (some combining marks live below 0x1100, so this must
  // precede the Latin fast-return).
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0; // combining / VS / ZWJ
  if (cp < 0x1100) return 1; // ASCII + Latin — the overwhelmingly common case
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) || // Mahjong … Symbols-and-Pictographs-Extended (incl. flags 1F1E6-1F1FF, 🔋 1F50B)
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK extension planes
  ) return 2;
  // NOTE (v1.47.3): the Misc-Symbols/Dingbats block (0x2600-0x27BF: ☀ ⚡ ❤ …)
  // is deliberately NOT counted as wide. Those code points have
  // terminal-DEPENDENT presentation, and this renderer uses several of them
  // (☀ ⚡ ⌁ ⏱ ▮ in the console mimic) as SINGLE-column decorations — counting
  // them 2 would break its own layout. They therefore measure 1, consistent
  // with the renderer's own usage; a device name carrying one may be ±1 col on
  // an emoji-presentation terminal (accepted, low-frequency).
  return 1;
}

/** On-screen column count of a string, ignoring ANSI escape codes. */
export function visLen(s: string): number {
  const plain = s.replace(ANSI_RE, '');
  // Fast path: pure ASCII measures as .length.
  let ascii = true;
  for (let i = 0; i < plain.length; i++) {
    if (plain.charCodeAt(i) > 0x7e) { ascii = false; break; }
  }
  if (ascii) return plain.length;
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncate to a visible width, keeping ANSI codes intact and resetting at the cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (visLen(s) <= width) return s;
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < width) {
    if (s[i] === ESC) {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    // v1.47.2 — advance by CODE POINT and count display columns, so a
    // double-width glyph is either kept whole or dropped, never split.
    const cp = s.codePointAt(i)!;
    const cw = charWidth(cp);
    if (vis + cw > width) break;
    const chLen = cp > 0xffff ? 2 : 1;
    out += s.slice(i, i + chLen);
    vis += cw;
    i += chLen;
  }
  return out + RESET;
}

/** Pad (or truncate) to an exact visible width, content left-aligned. */
export function padEnd(s: string, width: number): string {
  const len = visLen(s);
  if (len > width) {
    // v1.47.3 — truncate() may stop one column short when a double-width glyph
    // straddles the cut; re-pad so the contract (exactly `width`) still holds.
    const t = truncate(s, width);
    return t + ' '.repeat(Math.max(0, width - visLen(t)));
  }
  return s + ' '.repeat(width - len);
}

/** Pad (or truncate) to an exact visible width, content right-aligned. */
export function padStart(s: string, width: number): string {
  const len = visLen(s);
  if (len > width) {
    const t = truncate(s, width);
    return ' '.repeat(Math.max(0, width - visLen(t))) + t;
  }
  return ' '.repeat(width - len) + s;
}

/** Centre content within a visible width. */
export function center(s: string, width: number): string {
  const len = visLen(s);
  if (len >= width) return truncate(s, width);
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + s + ' '.repeat(width - len - left);
}

/** Left content + right content with the gap stretched between them. */
export function lr(left: string, right: string, width: number): string {
  const gap = width - visLen(left) - visLen(right);
  if (gap < 1) return truncate(left + ' ' + right, width);
  return left + ' '.repeat(gap) + right;
}

/** A horizontal meter: filled blocks + empty blocks, coloured by fill fraction. */
export function bar(frac: number, width: number, color: keyof typeof c = 'green'): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  return c[color]('█'.repeat(filled)) + c.grey('░'.repeat(Math.max(0, width - filled)));
}


/** v1.47.3 — display columns of a PLAIN (no-ANSI) string. */
export function displayWidth(s: string): number { return visLen(s); }

/**
 * v1.47.3 — word-wrap PLAIN text (no ANSI) to a DISPLAY width, so CJK/emoji
 * content wraps at the right visual column instead of code-unit count. A word
 * longer than the width is hard-split on a display-column boundary (never
 * mid-double-width-glyph). Mirrors the prior alm wrap semantics, width-correct.
 */
export function wrapDisplay(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  // Split a plain word into <= w-display-column chunks, whole glyphs only.
  const hardSplit = (word: string): string[] => {
    const chunks: string[] = [];
    let cur = '';
    let curW = 0;
    for (const ch of word) {
      const cw = displayWidth(ch);
      if (curW + cw > w) { chunks.push(cur); cur = ''; curW = 0; }
      cur += ch;
      curW += cw;
    }
    if (cur) chunks.push(cur);
    return chunks;
  };
  let cur = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const pieces = displayWidth(word) > w ? hardSplit(word) : [word];
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k];
      // A hard-split remainder always starts its own line except the last piece.
      if (k < pieces.length - 1) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(piece);
        continue;
      }
      if (!cur) cur = piece;
      else if (displayWidth(cur) + 1 + displayWidth(piece) <= w) cur += ' ' + piece;
      else { lines.push(cur); cur = piece; }
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
