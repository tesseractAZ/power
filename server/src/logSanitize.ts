/**
 * Tiny shared sanitizers for request/network-derived values that are
 * INTENTIONALLY persisted (audit log, alert outcomes, model notes).
 *
 * These do not make tainted data "safe" in the CodeQL sense — recording
 * request provenance is the feature — but they bound what can land on disk:
 * known types only, control characters stripped, lengths clamped, numbers
 * coerced finite. Callers re-serialize an explicit typed shape built from
 * these instead of writing the raw request-derived object.
 */

/** Strip C0/DEL control characters and bound length; non-strings → undefined. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/**
 * v1.7.0 (security #2, CWE-150) — sanitize a cloud/MQTT-sourced DISPLAY name
 * (device name, SHP2 breaker-circuit name) before it can reach the telnet/console
 * ANSI render stream. Strips ALL C0 controls (incl. ESC 0x1b), DEL, and C1
 * (0x7f–0x9f, where 0x9b is an 8-bit CSI some terminals honor), so a name set in
 * the EcoFlow app / SHP2 config can't inject terminal escape sequences (OSC
 * title-set, OSC 52 clipboard-write, cursor control) that execute in the
 * operator's terminal when they view the TUI. Collapses runs to a space and
 * clamps length; a non-string or all-control input yields the fallback.
 */
export function sanitizeDisplayName(v: unknown, max = 64, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
  return cleaned || fallback;
}

/** Like cleanText, but preserves \n and \t (operator-typed multi-line notes). */
export function cleanMultilineText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** Finite number or undefined (JSON.stringify drops undefined keys, so an
 *  absent/invalid number serializes the same as an absent field). */
export function finiteNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
