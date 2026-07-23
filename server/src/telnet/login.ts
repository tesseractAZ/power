/**
 * v1.46.0 — operator login screen.
 *
 * The single console (see session.ts) is gated by an optional username +
 * password configured through the add-on options (`TUI_USERNAME` /
 * `TUI_PASSWORD`). This module renders the login card; the input state
 * machine lives in the session driver so BOTH transports (telnet TCP and the
 * /console browser terminal) share one implementation.
 *
 * Pure: (state, width, height) → frame lines. The brand block is the same
 * pseudo-LCD lettering the mode chooser used before consolidation.
 */

import { c, center } from './ansi.js';

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
  '███████  ██████   ██████  ███████ ██       ██████  ██     ██   ',
  '██      ██       ██    ██ ██      ██      ██    ██ ██     ██   ',
  '█████   ██       ██    ██ █████   ██      ██    ██ ██  █  ██   ',
  '██      ██       ██    ██ ██      ██      ██    ██ ██ ███ ██   ',
  '███████  ██████   ██████  ██      ███████  ██████   ███ ███    ',
];

/** A prompt row: label + value field with a cursor block on the active field. */
function field(label: string, value: string, active: boolean, width: number): string {
  const cursor = active ? c.whiteB('█') : ' ';
  const body = `${label.padStart(10)} : ${value}${cursor}`;
  return center(active ? c.whiteB(body) : c.grey(body), width);
}

export function renderLogin(st: LoginViewState, width: number, height: number): string[] {
  const out: string[] = [];
  const topPad = Math.max(1, Math.floor(height * 0.12));
  for (let i = 0; i < topPad; i++) out.push('');
  for (const line of BRAND) out.push(center(c.cyanB(line), width));
  out.push(center(c.dim('P L A N T   C O N T R O L   S T A T I O N'), width));
  out.push('');
  out.push(center(c.grey('─'.repeat(Math.min(44, Math.max(20, width - 8)))), width));
  out.push('');
  out.push(field('USERNAME', st.user, st.stage === 'username', width));
  out.push(field('PASSWORD', '●'.repeat(st.passLen), st.stage === 'password', width));
  out.push('');
  if (st.error) {
    out.push(center(c.redB(`✗ ${st.error} — ${st.attemptsLeft} attempt(s) remaining`), width));
  } else {
    out.push(center(c.dim('ENTER to submit · operator credentials are set in the add-on configuration'), width));
  }
  while (out.length < height - 1) out.push('');
  return out.slice(0, height);
}
