/**
 * The web's mirror of the server's alarm-level vocabulary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `web` and `server` share no types — the console casts `r.json()` responses to
 * local interfaces — so nothing structurally couples this vocabulary to
 * `chimeConfig.CHIME_LEVELS`. Until now these three declarations lived inside
 * `AlertConsolePanel.tsx` as module-private consts, which made them
 * *unreachable* to any test: the server runner globs `test/**\/*.test.ts` and
 * cannot import a `.tsx` component.
 *
 * The consequence, in the specific change this is groundwork for: widening the
 * server's level union without widening this one is invisible. `tsc` passes on
 * both packages (the cast hides it), CI passes, and the operator gets a console
 * that silently cannot address the new rung — the exact "four listed, three
 * selectable" complaint, reproduced with no signal.
 *
 * Living in a plain `.ts` module, these can be imported by a test that asserts
 * key-set equality against the server's `CHIME_LEVELS`. Keep them here.
 */

// v1.59.0 — ONE severity ladder. Was the three audio levels ('red'|'yellow'|
// 'green'); now the four ISA priorities plus the all-clear, matching the server's
// AlarmRung exactly. Pinned by server/test/alarmLevelWebMirror.test.ts.
export type Level = 'critical' | 'high' | 'medium' | 'low' | 'clear';

/** Display order — must match the server's `CHIME_LEVELS`. */
// `as const satisfies` — NOT `: readonly Level[]`. An array annotation accepts a
// SHORT array, so dropping a level would still typecheck and simply never render.
export const LEVELS = ['critical', 'high', 'medium', 'low', 'clear'] as const satisfies readonly Level[];

/** Theme colour token per level (presentation only). */
// Colour tokens mirror ALARM_PRIORITY_META's colorToken, plus 'ok' for the all-clear.
export const LEVEL_TOKEN: Record<Level, string> = {
  critical: 'bad', high: 'high', medium: 'warn', low: 'info', clear: 'ok',
};

/**
 * Basename of the level's built-in klaxon, for the console's preview button.
 * Mirrors the server's `KLAXON_FOR_LEVEL` minus the `.wav` suffix; a mismatch
 * makes preview play a different sound than the alarm actually will.
 */
export const KLAXON_FILE: Record<Level, string> = {
  critical: 'red-alert',
  high: 'powerplant-red-alert',
  medium: 'yellow-alert',
  low: 'powerplant-yellow-alert',
  clear: 'all-clear',
};
