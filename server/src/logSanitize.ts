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
