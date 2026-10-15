/**
 * v1.188.0 — heading ids GitHub's Markdown API (mode=markdown, this repository's context) gives,
 * for the characters where a slugger that keeps "every letter, mark and number" goes wrong:
 * superscripts, subscripts and fractions (Unicode "other numbers") are deleted, while decimal
 * digits in any script, letter numbers and the zero-width joiner and non-joiner are kept, and
 * other format characters (the soft hyphen) are deleted. The reference writes `W/m²` and
 * `Σ(ghi²)` in its prose, so a heading like these is a matter of time.
 *
 * docsLayout.test.ts holds scripts/lib/markdownScan.mjs (D5's slugger) to this table and
 * docsBuild.test.ts holds the Python copy in scripts/build-docs-docx.py to it. Both sluggers can
 * agree with each other and still disagree with GitHub, so neither is checked only against the
 * other.
 */
export const GITHUB_NUMBER_AND_JOINER_SLUGS: readonly [heading: string, id: string][] = [
  ['3.2 Fit quality (R²) per W/m²', '32-fit-quality-r-per-wm'],
  ['CO₂ ½ test', 'co--test'],
  ['Σ(ghi²) sum', 'σghi-sum'],
  ['x⁰¹₂ y', 'x-y'],
  ['zero‍width‌joiners', 'zero‍width‌joiners'],
  ['Roman Ⅻ numeral', 'roman-ⅻ-numeral'],
  ['Arabic ٣ digit', 'arabic-٣-digit'],
  ['soft­hyphen', 'softhyphen'],
];
