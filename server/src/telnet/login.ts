/**
 * v1.46.0 — operator login screen.
 *
 * The single console (see session.ts) is gated by an optional username +
 * password configured through the add-on options (`TUI_USERNAME` /
 * `TUI_PASSWORD`). This module renders the login card for the /console browser
 * terminal; the input state machine lives in the session driver. The SSH
 * transport authenticates at the protocol level and never draws the card.
 *
 * Pure: (state, width, height) → frame lines. The brand block is the same
 * pseudo-LCD lettering the mode chooser used before consolidation.
 *
 * v1.191.5 — a sign-on panel in the manner of a 1980s business terminal: a framed
 * SIGN ON panel, dot-leader labels and a fixed box per field. Each prompt row used
 * to be centred as a whole, so every typed character moved the row half a column
 * left. Now the panel's place comes from its fixed width alone, a value scrolls
 * inside its box instead of widening it, and messages sit on their own line below.
 */

import { c, center, padEnd, truncate } from './ansi.js';

export interface LoginViewState {
  stage: 'username' | 'password';
  /** Typed username (echoed as-is). */
  user: string;
  /** Length of the typed password (echoed masked — the value never renders). */
  passLen: number;
  /** Attempts remaining before disconnect. */
  attemptsLeft: number;
  /** Set after a rejected attempt; cleared on next keystroke. */
  error: string | null;
}

const BRAND = [
  '██████    ██████   ██     ██  ███████  ██████  ',
  '██   ██  ██    ██  ██     ██  ██       ██   ██ ',
  '██████   ██    ██  ██  █  ██  █████    ██████  ',
  '██       ██    ██  ██ ███ ██  ██       ██   ██ ',
  '██        ██████    ███ ███   ███████  ██    ██',
];

/** The sign-on panel's width (frame included); narrower only on a narrower terminal. */
const PANEL_W = 52;
/** "  User ID . . . . . " — label column, dot leaders included. */
const LABEL_W = 20;
const LABELS = { username: 'User ID . . . . .', password: 'Password  . . . .' } as const;

/**
 * One field: three rows of a box whose inside holds `inner` cells. The value is shown
 * left-aligned; one too long for the box shows its tail, so the cursor stays in view
 * and the box never grows.
 */
function fieldBox(label: string, value: string, active: boolean, inner: number): [string, string, string] {
  const room = active ? inner - 1 : inner; // the cursor takes a cell
  const shown = value.length > room ? value.slice(value.length - room) : value;
  const text = padEnd(active ? c.white(shown) + c.whiteB('█') : c.grey(shown), inner);
  const edge = active ? c.whiteB : c.grey;
  const pad = ' '.repeat(LABEL_W);
  return [
    pad + edge(`┌${'─'.repeat(inner + 2)}┐`),
    padEnd(`  ${active ? c.whiteB(label) : c.grey(label)}`, LABEL_W) + edge('│') + ` ${text} ` + edge('│'),
    pad + edge(`└${'─'.repeat(inner + 2)}┘`),
  ];
}

export function renderLogin(st: LoginViewState, width: number, height: number): string[] {
  const panelW = Math.max(40, Math.min(PANEL_W, width - 2));
  const innerW = panelW - 2;                 // between the frame's verticals
  const boxInner = innerW - LABEL_W - 2 - 4; // two cells of right margin, "│ " and " │"
  const row = (s: string) => c.cyan('║') + padEnd(s, innerW) + c.cyan('║');
  const title = ' SIGN ON ';
  const panel: string[] = [
    c.cyan(`╔══${title}${'═'.repeat(innerW - 2 - title.length)}╗`),
    row(''),
    row(`  ${c.grey('System  . . . . .')}   ${c.whiteB('POWER')}`),
    row(''),
    ...fieldBox(LABELS.username, st.user, st.stage === 'username', boxInner).map(row),
    ...fieldBox(LABELS.password, '*'.repeat(st.passLen), st.stage === 'password', boxInner).map(row),
    row(''),
    c.cyan(`╚${'═'.repeat(innerW)}╝`),
  ];
  const message = st.error
    ? c.redB(`${st.error} — ${st.attemptsLeft} attempt(s) remaining`)
    : c.dim('Operator credentials are set in the add-on configuration.');
  const below = ['', `  ${c.grey('ENTER=Submit   BACKSPACE=Correct')}`, `  ${message}`];

  // The banner only when the terminal has the rows for it; nothing here depends on what is typed.
  const banner = height >= 26 ? [...BRAND.map((l) => center(c.cyanB(l), width)), center(c.dim('P L A N T   C O N T R O L   S T A T I O N'), width), ''] : [];
  const used = banner.length + panel.length + below.length;
  const out: string[] = Array.from({ length: Math.max(1, Math.floor((height - used) / 3)) }, () => '');
  out.push(...banner);
  const left = ' '.repeat(Math.max(0, Math.floor((width - panelW) / 2)));
  for (const l of [...panel, ...below]) out.push(truncate(left + l, width));
  while (out.length < height - 1) out.push('');
  return out.slice(0, height);
}
