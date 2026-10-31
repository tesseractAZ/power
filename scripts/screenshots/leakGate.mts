/**
 * leakGate.mts — what capture.mts checks in a rendered page before it writes an image (v1.193.0).
 *
 * check-no-secrets.py reads text files only, so nothing in CI can see inside a PNG. The capture tool
 * therefore reads the page it is about to photograph — its text, and an OCR read of the pixels — and
 * refuses to write the image on any of:
 *   - in the page's text only: a 16-character serial-shaped token that is not a placeholder, or a
 *     placeholder the fixture does not define (the page must show the fixture's devices and nothing
 *     else). OCR reads a 0 as an O, so this rule is not applied to an OCR read;
 *   - in the page's text and in an OCR read: a device name ending in a hyphen and four digits.
 *     EcoFlow names a device "<product>-<last four digits of its serial>" until it is renamed, which
 *     is not serial-shaped: a shape rule alone passes it, and the images this replaces carried one;
 *   - in either: a positive control missing, a name the page must show not in the text read. A reader
 *     that read nothing (an empty page, a blank OCR) would otherwise report clean.
 * PURE: no I/O. Every finding is a label; none echoes the text it matched (a serial's first four
 * characters are its public model code).
 */

/** A 16-character token of uppercase letters and digits, not part of a longer word. */
const SERIAL_TOKEN = /(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/g;
/** A placeholder's characters 5-16: every letter X, every digit 0, then a two-digit index. */
const PLACEHOLDER_TAIL = /^[X0]{10}[0-9]{2}$/;
/**
 * "-dddd" closing a name, not followed by a digit, after one of: a letter ("Smart Generator-"), a
 * closing parenthesis ("(Dual Fuel)-"), or a model number of up to four digits that follows a letter,
 * with or without a space ("Smart Home Panel 2-", "DELTA 1300-", "SHP2-"). The last case is not
 * rare: a product name ending in a digit is a common default name, the panel's own among them. A run
 * of digits with no letter before it (a date, a phone number) does not match; a word and then a range
 * ("at 1000-2000") does, and that false finding stops the capture, the side to fail on.
 */
export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)]|[A-Za-z] ?\d{1,4})-\d{4}(?!\d)/;

export const isSerialShaped = (tok: string): boolean => /[A-Z]/.test(tok) && /[0-9]/.test(tok);
export const isPlaceholderSerial = (tok: string): boolean => PLACEHOLDER_TAIL.test(tok.slice(4));

/** The DOM-text rules. `serials`: the placeholders the page may show (omit to skip the serial rule). */
export function renderedTextProblems(text: string, opts: { serials?: ReadonlySet<string>; mustContain: readonly string[] }): string[] {
  const out: string[] = [];
  if (opts.serials) {
    for (const m of text.matchAll(SERIAL_TOKEN)) {
      const tok = m[0];
      if (!isSerialShaped(tok)) continue;
      if (!isPlaceholderSerial(tok)) out.push(`serial-shaped token (model code ${tok.slice(0, 4)})`);
      else if (!opts.serials.has(tok)) out.push('a placeholder serial the fixture does not define');
    }
  }
  if (DEFAULT_NAME_TAIL.test(text)) out.push('a device name ending in four digits');
  for (const name of opts.mustContain) {
    if (!text.includes(name)) out.push(`positive control missing: ${name}`);
  }
  return [...new Set(out)];
}

/**
 * The OCR rules: only those an OCR misread cannot trip. OCR reads a 0 as an O, so the serial shape
 * rule is not applied to it; the name rule is, with the positive controls and a floor on the lines
 * read (a read of a few words is no read of the page).
 */
export function ocrTextProblems(lines: readonly string[], opts: { mustContain: readonly string[]; minLines: number }): string[] {
  const out = renderedTextProblems(lines.join('\n'), { mustContain: opts.mustContain });
  if (lines.length < opts.minLines) out.push(`OCR read ${lines.length} line(s), fewer than ${opts.minLines}`);
  return out;
}
