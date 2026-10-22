#!/usr/bin/env node
/**
 * mutate-v1188-0.mjs — v1.188.0: the documentation is held to its size and structure by
 * scripts/check-docs.mjs (rules D1–D11, on the fence-aware scanner scripts/lib/markdownScan.mjs),
 * and the printable is assembled from the manifest by scripts/build-docs-docx.py. Each mutant
 * disarms one of those guards; the docs tests must notice.
 *
 *   S   sizes (D1): each budget off, the guide's floor off, size counted in characters, a missing
 *       required page passing
 *   B   bytes and the Home Assistant surfaces (D2, D3): NUL allowed; in-page, relative, http,
 *       non-main or query-string links allowed; images and raw HTML allowed; the one-h1, section-sign,
 *       version and date bans off, or the version ban narrowed to the HA surfaces
 *   N   names (D4): an unknown option, a glob matching nothing, an unknown entity id, a missing
 *       entity page, a duplicated unique_id, a loose <ch> or <p> placeholder, the guide pages unchecked
 *   L   links, slugs and structure (D5, D6, scanner): a missing target, an unchecked fragment, a
 *       suffixed or shared slug, a #L line anchor; a punctuation-keeping or non-deduplicating
 *       slugger, one that keeps superscripts and fractions or drops letter numbers or the
 *       zero-width joiners, a fence-blind scanner, a short fence closer; an unclosed fence, an
 *       unlisted, missing, doubly listed or out-of-order manifest entry, a wrong chapter opening,
 *       a part out of sequence, an incomplete chapter or appendix set
 *   C   content rules (D7–D11): an option default, schema or row unchecked; a ratchet that does
 *       not demand lowering or lets a count rise; a release heading allowed; the history hash,
 *       banner or pin unchecked; a stale pointer or a dead docs/ mention allowed, extension-less
 *       files or .github unscanned; a writer dropped, a phrase dropped, the write section unbounded;
 *       a write-table row label matched in the section's prose, in any cell, without its bold, in
 *       another section's table, or regardless of case
 *   P   the printable: the last chapter dropped, a bundled link left external, an unresolved or
 *       non-unique link passing, history bundled, the synthetic h1 omitted, the alert marker
 *       kept, --fail-if-warnings or --resource-path dropped, a punctuation-keeping Python slugger,
 *       one that keeps superscripts and fractions or drops the zero-width joiners,
 *       a missing, unlisted or unprinted file passing, links not pinned to --ref, no page breaks
 *
 * Every anchor sits on a comparison, a condition or a call, never on a baseline value or a pinned
 * hash in scripts/docs-baselines.json, so lowering a ratchet cannot orphan one.
 *
 *   node scripts/mutate-v1188-0.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CD = resolve(REPO, 'scripts/check-docs.mjs');
const MS = resolve(REPO, 'scripts/lib/markdownScan.mjs');
const BD = resolve(REPO, 'scripts/build-docs-docx.py');
const SUBSET = [
  'test/docsLayout.test.ts',
  'test/docsBuild.test.ts',
  'test/nightChargeMqtt.test.ts',
];

const MUTANTS = [
  /* ── S: sizes (D1) ── */
  {
    id: 'S-i. ★★★ the guide has no size limit',
    file: CD,
    find: '      if (rel === GUIDE) return { limit: GUIDE_LIMIT_BYTES, target: GUIDE_TARGET_BYTES, floor: GUIDE_FLOOR_BYTES };',
    to: '      if (rel === GUIDE) return { limit: Infinity, target: GUIDE_TARGET_BYTES, floor: GUIDE_FLOOR_BYTES }; /* MUTANT */',
    why: 'The Documentation tab regrows past 48 KiB, and Home Assistant renders all of it on every open.',
  },
  {
    id: 'S-ii. ★★ the add-on card has no size limit',
    file: CD,
    find: '      if (rel === ADDON_README) return { limit: ADDON_README_LIMIT_BYTES };',
    to: '      if (rel === ADDON_README) return { limit: Infinity }; /* MUTANT */',
    why: 'The Info tab, shown every time the add-on is opened, grows without bound.',
  },
  {
    id: 'S-iii. ★★ the option and entity pages get the general 128 KiB budget',
    file: CD,
    find: '      if (isGuidePage(rel)) return { limit: GUIDE_PAGE_LIMIT_BYTES };',
    to: '      if (isGuidePage(rel)) return { limit: OTHER_DOC_LIMIT_BYTES }; /* MUTANT */',
    why: 'The option and entity pages can double before anything fails.',
  },
  {
    id: 'S-iv. ★ the reference index gets the chapter budget',
    file: CD,
    find: '      if (rel === REFERENCE_INDEX) return { limit: REFERENCE_INDEX_LIMIT_BYTES };',
    to: '      if (rel === REFERENCE_INDEX) return { limit: REFERENCE_LIMIT_BYTES }; /* MUTANT */',
    why: 'The index, the reference\'s only table of contents, grows into a chapter.',
  },
  {
    id: 'S-v. ★★★ a reference file has no size limit',
    file: CD,
    find: '      if (isReference(rel)) return { limit: REFERENCE_LIMIT_BYTES, target: REFERENCE_TARGET_BYTES };',
    to: '      if (isReference(rel)) return { limit: Infinity, target: REFERENCE_TARGET_BYTES }; /* MUTANT */',
    why: 'A chapter grows toward the size at which GitHub stops rendering it.',
  },
  {
    id: 'S-vi. ★ a history file has no size limit',
    file: CD,
    find: '      if (isHistory(rel)) return { limit: HISTORY_LIMIT_BYTES };',
    to: '      if (isHistory(rel)) return { limit: Infinity }; /* MUTANT */',
    why: 'A history file can be rolled into one file too large for GitHub to render.',
  },
  {
    id: 'S-vii. ★★ README, SECURITY and the other docs have no size limit',
    file: CD,
    find: '      return { limit: OTHER_DOC_LIMIT_BYTES };',
    to: '      return { limit: Infinity }; /* MUTANT */',
    why: 'PERFORMANCE.md and the README regrow the way DOCS.md once did.',
  },
  {
    id: 'S-viii. ★★ the guide floor is off',
    file: CD,
    find: '      if (b.floor !== undefined && size < b.floor) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A guide truncated to a stub ships to every install as the Documentation tab.',
  },
  {
    id: 'S-ix. ★★ size is counted in characters',
    file: CD,
    find: '      const size = d.size;',
    to: '      const size = d.text.length; /* MUTANT */',
    why: 'A guide of multi-byte text passes while its UTF-8 size is over the limit.',
  },
  {
    id: 'S-x. ★★ a missing required page passes',
    file: CD,
    find: "      if (!loadDoc(rel)) fail('D1', rel, 0, 'required file is missing');",
    to: '      /* MUTANT */',
    why: 'Deleting the add-on card or the reference index fails nothing.',
  },

  /* ── B: bytes and the Home Assistant surfaces (D2, D3) ── */
  {
    id: 'B-i. ★★★ a NUL byte is allowed',
    file: CD,
    find: '        if (b <= 0x1f || b === 0x7f) {',
    to: '        if ((b <= 0x1f && b !== 0x00) || b === 0x7f) { /* MUTANT */',
    why: 'A NUL in a Markdown file makes GitHub show it as raw text, as it did the old manual.',
  },
  {
    id: 'B-ii. ★★★ an in-page # link is allowed on the HA surfaces',
    file: CD,
    find: "if (l.dest.startsWith('#')) { fail('D3',",
    to: "if (l.dest.startsWith('#')) { continue; fail('D3', /* MUTANT */",
    why: 'Home Assistant gives headings no ids: every such link is dead in the tab.',
  },
  {
    id: 'B-iii. ★★★ a relative link is allowed on the HA surfaces',
    file: CD,
    find: "if (!u) { fail('D3',",
    to: "if (!u) { continue; fail('D3', /* MUTANT */",
    why: 'A relative link in the Documentation tab resolves against the Home Assistant frontend.',
  },
  {
    id: 'B-iv. ★★ an http link is allowed on the HA surfaces',
    file: CD,
    find: "if (u.protocol !== 'https:' && u.protocol !== 'mailto:') {",
    to: "if (u.protocol !== 'https:' && u.protocol !== 'mailto:' && u.protocol !== 'http:') { /* MUTANT */",
    why: 'A LAN address becomes a link the tab cannot open from outside the house.',
  },
  {
    id: 'B-v. ★★★ a repository link to a non-main ref is allowed',
    file: CD,
    find: "(kind === 'blob' || kind === 'tree') && r.segs[1] === 'main'",
    to: "(kind === 'blob' || kind === 'tree') && r.segs[1] !== '' /* MUTANT */",
    why: 'The Supervisor serves main\'s guide to every installed version; a branch or tag link goes stale.',
  },
  {
    id: 'B-vi. ★ a repository link with a query string is allowed',
    file: CD,
    find: "if (!(okTree || okSection) || r.url.search !== '') {",
    to: 'if (!(okTree || okSection)) { /* MUTANT */',
    why: 'A ?plain=1 link opens raw source in place of the rendered page.',
  },
  {
    id: 'B-vii. ★★ an image is allowed on the HA surfaces',
    file: CD,
    find: "if (l.image) { fail('D3',",
    to: "if (l.image) { continue; fail('D3', /* MUTANT */",
    why: 'The tab renders a broken image: the add-on serves no files to it.',
  },
  {
    id: 'B-viii. ★★ raw HTML other than comments, details, summary and br is allowed',
    file: CD,
    find: "else if (!ALLOWED_HTML.has(t.tag)) fail('D3',",
    to: "else if (false) fail('D3', /* MUTANT */",
    why: 'An unescaped placeholder like <age> is swallowed by the sanitiser and the sentence loses its word.',
  },
  {
    id: 'B-ix. ★ a second h1 is allowed',
    file: CD,
    find: "if (h1.length !== 1) fail('D3',",
    to: "if (h1.length === 0) fail('D3', /* MUTANT */",
    why: 'A pasted chapter brings its own title into the guide.',
  },
  {
    id: 'B-x. ★★ a section sign is allowed on the HA surfaces',
    file: CD,
    find: 'd.text.matchAll(new RegExp(SECTION_SIGN, \'g\'))',
    to: '[].values() /* MUTANT */',
    why: 'Section numbers are chapter-local in the reference; on the guide they point nowhere.',
  },
  {
    id: 'B-xi. ★★★ the version ban is off',
    file: CD,
    find: 'd.text.matchAll(VERSION)',
    to: '[].values() /* MUTANT */',
    why: 'Per-release narrative grows back into the guide, which is what grew the old manual to 1.1 MB.',
  },
  {
    id: 'B-xii. ★★ the date ban is off',
    file: CD,
    find: 'd.text.matchAll(ISO_DATE)',
    to: '[].values() /* MUTANT */',
    why: 'Dated incident notes accumulate on the operator pages.',
  },
  {
    id: 'B-xiii. ★★ the version and date bans cover only the HA surfaces',
    file: CD,
    find: '    for (const rel of [...HA_SURFACES, ...mdFiles.filter(isGuidePage)]) {\n      const d = loadDoc(rel);\n      if (!d) continue;\n      for (const m of d.text.matchAll(VERSION))',
    to: '    for (const rel of [...HA_SURFACES]) { /* MUTANT */\n      const d = loadDoc(rel);\n      if (!d) continue;\n      for (const m of d.text.matchAll(VERSION))',
    why: 'The option and entity pages collect "since 1.x" notes the guide is not allowed.',
  },

  /* ── N: names (D4) ── */
  {
    id: 'N-i. ★★★ an unknown option name passes',
    file: CD,
    find: "const known = t.includes('*') ? keys.some((k) => globMatches(t, k)) : keys.includes(t);",
    to: "const known = t.includes('*') ? keys.some((k) => globMatches(t, k)) : true; /* MUTANT */",
    why: 'The guide tells the operator to set an option that does not exist (or was renamed).',
  },
  {
    id: 'N-ii. ★ a PREFIX_* glob passes whether or not it matches a key',
    file: CD,
    find: "const known = t.includes('*') ? keys.some((k) => globMatches(t, k)) : keys.includes(t);",
    to: "const known = t.includes('*') ? keys.length > 0 : keys.includes(t); /* MUTANT */",
    why: 'A family of options named in the guide can vanish from config.yaml unnoticed.',
  },
  {
    id: 'N-iii. ★★★ an unknown entity id passes',
    file: CD,
    find: "if (id !== 'ecoflow_panel' && !patterns.some((p) => idMatches(id, p.id))) fail('D4',",
    to: "if (id !== 'ecoflow_panel' && patterns.length === 0) fail('D4', /* MUTANT */",
    why: 'An automation example in the guide names an entity Power never publishes.',
  },
  {
    id: 'N-iv. ★★★ --check skips the entity check when the entity page is missing',
    file: CD,
    find: "if (!ent) fail('D4', ENTITIES_PAGE, 0, 'missing",
    to: "if (false) fail('D4', ENTITIES_PAGE, 0, 'missing /* MUTANT */",
    why: 'Deleting the entity page turns every entity-id check into a pass.',
  },
  {
    id: 'N-v. ★ a duplicated unique_id row passes',
    file: CD,
    find: "if (seen.has(p.id)) fail('D4',",
    to: "if (false) fail('D4', /* MUTANT */",
    why: 'An entity documented twice can say two different things.',
  },
  {
    id: 'N-vi. ★★ the <ch> placeholder matches any characters',
    file: CD,
    find: "while (k < id.length && id[k] >= '0' && id[k] <= '9') { k++; if (rec(pi + 1, k)) return true; }",
    to: "while (k < id.length && id[k] !== '/') { k++; if (rec(pi + 1, k)) return true; } /* MUTANT */",
    why: 'A circuit entity named by its label rather than its channel number passes as documented.',
  },
  {
    id: 'N-vii. ★★ the <p> placeholder matches any word',
    file: CD,
    find: "if (part === '<p>') return PRIORITIES.some((p) => id.startsWith(p, si) && rec(pi + 1, si + p.length));",
    to: "if (part === '<p>') return si < id.length && rec(pi + 1, id.length); /* MUTANT */",
    why: 'A priority switch for a priority that does not exist passes as documented.',
  },
  {
    id: 'N-viii. ★★ names are checked on the HA surfaces only',
    file: CD,
    find: '    for (const rel of [...HA_SURFACES, ...mdFiles.filter(isGuidePage)]) {\n      const d = loadDoc(rel);\n      if (!d) continue;\n      for (const c of d.scan.codeSpans) {',
    to: '    for (const rel of [...HA_SURFACES]) { /* MUTANT */\n      const d = loadDoc(rel);\n      if (!d) continue;\n      for (const c of d.scan.codeSpans) {',
    why: 'The option and entity pages may name options and entities that do not exist.',
  },

  /* ── L: links, slugs and structure (D5, D6, the scanner) ── */
  {
    id: 'L-i. ★★★ a missing relative link target passes',
    file: CD,
    find: "if (!tree.fileSet.has(target) && !tree.dirs.has(target)) { fail('D5',",
    to: "if (false) { fail('D5', /* MUTANT */",
    why: 'A link into a reference file that was renamed or split lands on a 404.',
  },
  {
    id: 'L-ii. ★★★ a missing blob/main target passes',
    file: CD,
    find: "if (!exists) { fail('D5',",
    to: "if (false) { fail('D5', /* MUTANT */",
    why: 'An absolute link in the Documentation tab lands on a 404.',
  },
  {
    id: 'L-iii. ★★★ a relative link\'s fragment is not checked',
    file: CD,
    find: 'checkFragment(rel, l.line, target, f, dest);',
    to: '/* MUTANT */',
    why: 'A link to a renamed heading opens the top of the file, silently.',
  },
  {
    id: 'L-iv. ★★ a blob/main link\'s fragment is not checked',
    file: CD,
    find: 'checkFragment(rel, l.line, path, f, dest);',
    to: '/* MUTANT */',
    why: 'The guide\'s deep links into the reference rot unnoticed.',
  },
  {
    id: 'L-v. ★★★ a -N suffixed or shared slug is accepted',
    file: CD,
    find: 'if (owners.length !== 1 || carriers.length !== 1 || carriers[0] !== owners[0]) {',
    to: 'if (carriers.length !== 1) { /* MUTANT */',
    why: 'A link to the second of two same-named headings moves when a heading is added above it.',
  },
  {
    id: 'L-vi. ★★ a #L line anchor is accepted',
    file: CD,
    find: 'if (/^L\\d/.test(frag)) {',
    to: 'if (false) { /* MUTANT */',
    why: 'A line anchor points at a different line after the next edit.',
  },
  {
    id: 'L-vii. ★★★ the slugger keeps punctuation',
    file: MS,
    find: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\u200C\\u200D\\- ]/gu;',
    to: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\u200C\\u200D\\p{P}\\- ]/gu; /* MUTANT */',
    why: 'Every checked fragment is compared with an id GitHub never generates.',
  },
  {
    id: 'L-viii. ★★ the slugger does not deduplicate',
    file: MS,
    find: '    while (occurrences.has(result)) {',
    to: '    while (false) { /* MUTANT */',
    why: 'Two same-named headings get one id, and a -N link is read as unique.',
  },
  {
    id: 'L-ix. ★★★ the scanner is fence-blind',
    file: MS,
    find: '      const f = fenceOpen(content);',
    to: '      const f = null; /* MUTANT */',
    why: 'A "# comment" in a shell example counts as a heading: slugs shift and chapters miscount.',
  },
  {
    id: 'L-x. ★★ a shorter fence closes a longer one',
    file: MS,
    find: '  if (n < fence.len) return false;',
    to: '  /* MUTANT */',
    why: 'A ``` inside a ```` example ends the code block early and its contents become Markdown.',
  },
  {
    id: 'L-xi. ★★ an unclosed fence passes',
    file: CD,
    find: "if (d.scan.unclosedFence !== null) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'The rest of a chapter renders as one code block on GitHub.',
  },
  {
    id: 'L-xii. ★★★ an unlisted reference file passes',
    file: CD,
    find: "if (!listedNames.includes(f)) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'The printable builds from the manifest: an unlisted chapter is silently left out.',
  },
  {
    id: 'L-xiii. ★★★ a listed but missing reference file passes',
    file: CD,
    find: "if (!refFiles.includes(x.file)) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'The index links a chapter that is not there.',
  },
  {
    id: 'L-xiv. ★ a doubly listed reference file passes',
    file: CD,
    find: 'if (listedNames.indexOf(x.file) !== listedNames.lastIndexOf(x.file) && listedNames.indexOf(x.file) !== listed.indexOf(x)) {',
    to: 'if (false) { /* MUTANT */',
    why: 'A chapter is printed twice and its every heading id collides.',
  },
  {
    id: 'L-xv. ★★ the manifest order is not checked',
    file: CD,
    find: "if (order[i - 1] >= order[i]) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'The printable prints part 2 of a chapter before part 1.',
  },
  {
    id: 'L-xvi. ★★ a chapter file need not open with its own "## N." heading',
    file: CD,
    find: "if (!first || first.level !== 2 || !first.raw.startsWith(want2)) fail('D6',",
    to: "if (!first || first.level !== 2) fail('D6', /* MUTANT */",
    why: 'Chapter 7 can sit in the file named for chapter 1.',
  },
  {
    id: 'L-xvii. ★ a later part need not open with ###',
    file: CD,
    find: "if (!first || first.level !== 3) fail('D6',",
    to: "if (!first) fail('D6', /* MUTANT */",
    why: 'A part opening with a deeper heading nests under the wrong section in the printable outline.',
  },
  {
    id: 'L-xviii. ★ a part need not follow the part before it',
    file: CD,
    find: "if (!prev || prev.chapter !== name.chapter || prev.part !== name.part - 1) fail('D6',",
    to: "if (!prev) fail('D6', /* MUTANT */",
    why: 'Part 3 of a chapter exists with no part 2, so the chapter has a hole.',
  },
  {
    id: 'L-xix. ★★★ the chapter set is not checked',
    file: CD,
    find: "if (chapters.join(',') !== expected) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'A chapter deleted along with its manifest line goes unnoticed.',
  },
  {
    id: 'L-xx. ★★ the appendix set is not checked',
    file: CD,
    find: "if (appendices.join(',') !== wantAppendices.join(',')) fail('D6',",
    to: "if (false) fail('D6', /* MUTANT */",
    why: 'The feature inventory can disappear with its manifest line.',
  },
  {
    id: 'L-xxi. ★★ the slugger keeps superscripts, subscripts and fractions',
    file: MS,
    find: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\u200C\\u200D\\- ]/gu;',
    to: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200C\\u200D\\- ]/gu; /* MUTANT */',
    why: 'A heading "Fit quality (R²)" gets an id ending in r² where GitHub\'s ends in r: D5 rejects the live fragment and accepts the dead one.',
  },
  {
    id: 'L-xxii. ★ the slugger drops letter numbers',
    file: MS,
    find: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\u200C\\u200D\\- ]/gu;',
    to: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D\\- ]/gu; /* MUTANT */',
    why: 'A heading with a Roman numeral character gets an id GitHub never generates.',
  },
  {
    id: 'L-xxiii. ★ the slugger drops the zero-width joiners',
    file: MS,
    find: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\u200C\\u200D\\- ]/gu;',
    to: 'const SLUG_REMOVE = /[^\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\- ]/gu; /* MUTANT */',
    why: 'A heading written in a script that joins with ZWJ or ZWNJ gets an id GitHub never generates.',
  },

  /* ── C: content rules (D7–D11) ── */
  {
    id: 'C-i. ★★★ an option default is not compared with config.yaml',
    file: CD,
    find: "if (!sameScalar(def, cfgDef)) fail('D7',",
    to: "if (false) fail('D7', /* MUTANT */",
    why: 'The option page states a default the add-on does not use.',
  },
  {
    id: 'C-ii. ★★★ an option schema is not compared with config.yaml',
    file: CD,
    find: "if (schema !== cfgSchema) fail('D7',",
    to: "if (false) fail('D7', /* MUTANT */",
    why: 'The option page states a range or a choice list the Configuration tab rejects.',
  },
  {
    id: 'C-iii. ★★★ an option with no row passes',
    file: CD,
    find: "for (const key of config.schema.keys()) if (!rows.has(key)) fail('D7',",
    to: "for (const key of config.schema.keys()) if (false) fail('D7', /* MUTANT */",
    why: 'A new option ships undocumented.',
  },
  {
    id: 'C-iv. ★ an option with two rows passes',
    file: CD,
    find: "if (rows.has(key)) { fail('D7',",
    to: "if (false) { fail('D7', /* MUTANT */",
    why: 'An option documented twice, with two defaults, and only one of them checked.',
  },
  {
    id: 'C-v. ★★ a ratchet that falls is not lowered',
    file: CD,
    find: 'if (actual !== expected) {',
    to: 'if (actual > expected) { /* MUTANT */',
    why: 'The baseline stays high after a cleanup, leaving room for the count to regrow.',
  },
  {
    id: 'C-vi. ★★★ a ratchet may rise',
    file: CD,
    find: 'if (actual !== expected) {',
    to: 'if (actual < expected) { /* MUTANT */',
    why: 'Per-release paragraphs, file:line citations and section signs grow back into the reference.',
  },
  {
    id: 'C-vii. ★★ a release-log heading is allowed',
    file: CD,
    find: "if (RELEASE_HEADING.test(h.text)) fail('D8',",
    to: "if (false) fail('D8', /* MUTANT */",
    why: 'A new release log starts in the reference, as the 174 KB one in chapter 10 did.',
  },
  {
    id: 'C-viii. ★★★ the history hash is not checked',
    file: CD,
    find: "if (actual !== pin) fail('D9',",
    to: "if (!pin) fail('D9', /* MUTANT */",
    why: 'The frozen history is edited in place and no longer matches what was moved.',
  },
  {
    id: 'C-ix. ★★ the history banner is not checked',
    file: CD,
    find: "if (lines[0] !== '> [!NOTE]' || !banner.includes('historical') || !banner.includes('superseded')) {",
    to: "if (lines[0] !== '> [!NOTE]') { /* MUTANT */",
    why: 'A reader takes a superseded figure (the 90 % ceiling) for the current one.',
  },
  {
    id: 'C-x. ★★ an unpinned history file passes',
    file: CD,
    find: "if (!Object.hasOwn(pins, rel)) { fail('D9',",
    to: "if (false) { fail('D9', /* MUTANT */",
    why: 'A new file in docs/history is never frozen.',
  },
  {
    id: 'C-xi. ★★★ a pointer into the old manual is allowed',
    file: CD,
    find: 'for (const m of text.matchAll(MONOLITH_POINTER)) {',
    to: 'for (const m of text.matchAll(MONOLITH_POINTER)) { continue; /* MUTANT */',
    why: 'Code comments go on citing section numbers of a file that is now the short guide.',
  },
  {
    id: 'C-xii. ★★ a quoted-heading pointer with a straight quote is allowed',
    file: CD,
    find: "LEFT_QUOTE + ']|[",
    to: "LEFT_QUOTE + ']|(?!)[",
    why: 'The commonest pointer form in code comments goes stale unnoticed.',
  },
  {
    id: 'C-xiii. ★★★ a docs/… .md mention that does not exist passes',
    file: CD,
    find: "if (!tree.fileSet.has(mention)) fail('D10',",
    to: "if (false) fail('D10', /* MUTANT */",
    why: 'A comment names a reference file that was renamed or never existed.',
  },
  {
    id: 'C-xiv. ★ files with no extension are not scanned for pointers',
    file: CD,
    find: "'.plist', '.xml', '']);",
    to: "'.plist', '.xml']); /* MUTANT */",
    why: 'The rootfs scripts the image ships (no extension) keep stale pointers.',
  },
  {
    id: 'C-xv. ★★ .github is not scanned',
    file: CD,
    find: "const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);",
    to: "const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github']); /* MUTANT */",
    why: 'The workflows and the PR template keep pointers into the old manual.',
  },
  {
    id: 'C-xvi. ★★★ a writer is dropped from WRITERS',
    file: CD,
    find: "  debugSendCommand: ['Raw command'],",
    to: '  /* MUTANT */',
    why: 'The guide\'s write list stops naming a way Power writes to the panel.',
  },
  {
    id: 'C-xvii. ★★★ only the first phrase of each writer is required',
    file: CD,
    find: '          for (const p of phrases) {',
    to: '          for (const p of phrases.slice(0, 1)) { /* MUTANT */',
    why: 'The reserve-floor or force-charge-OFF row can leave the write list.',
  },
  {
    id: 'C-xviii. ★★ the write section runs to the end of the guide',
    file: CD,
    find: 'const next = d.scan.headings.find((x) => x.line > h.line && x.level <= 2);',
    to: 'const next = null; /* MUTANT */',
    why: 'A writer mentioned anywhere in the guide counts as listed in the write table.',
  },
  {
    id: 'C-xix. ★★★ a sentence of the write section stands in for a writer\'s row',
    file: CD,
    find: "        const labels = tables.flatMap((t) => t.rows.map((r) => r.cells[0] ?? ''));",
    to: '        const labels = d.scan.lines.slice(h.line - 1, next ? next.line - 1 : undefined); /* MUTANT */',
    why: 'The two-panel paragraph says "set the reserve floor", so the reserve-floor row can leave the write list with the check green.',
  },
  {
    id: 'C-xx. ★★ any cell of a row counts as its label',
    file: CD,
    find: "        const labels = tables.flatMap((t) => t.rows.map((r) => r.cells[0] ?? ''));",
    to: "        const labels = tables.flatMap((t) => t.rows.map((r) => r.cells.join(' | '))); /* MUTANT */",
    why: 'A writer named only inside another writer\'s row (its trigger or off switch) counts as having a row.',
  },
  {
    id: 'C-xxi. ★★ a row label need not be bold',
    file: CD,
    find: '            const bold = `**${p}**`;',
    to: '            const bold = p; /* MUTANT */',
    why: 'A label that only mentions a writer in plain words, not as the row\'s bold name, counts as its row.',
  },
  {
    id: 'C-xxii. ★★ a table in another section counts',
    file: CD,
    find: '        const tables = readTables(d.scan).filter((t) => t.line > h.line && t.line < end);',
    to: '        const tables = readTables(d.scan); /* MUTANT */',
    why: 'A writer listed only in a troubleshooting row counts as listed in the write table.',
  },
  {
    id: 'C-xxiii. ★ a row label is matched regardless of case',
    file: CD,
    find: '            if (!labels.some((label) => label.includes(bold))) {',
    to: '            if (!labels.some((label) => label.toLowerCase().includes(bold.toLowerCase()))) { /* MUTANT */',
    why: 'The labels drift from the WRITERS phrases they are held to, and "force charge off" matches a label it was not written for.',
  },

  /* ── P: the printable (build-docs-docx.py) ── */
  {
    id: 'P-i. ★★★ the last chapter is dropped',
    file: BD,
    find: '    for name in manifest:\n        plan.append((reference_kind(name), f"{REFERENCE_DIR}/{name}"))',
    to: '    for name in manifest[:-1]:  # MUTANT\n        plan.append((reference_kind(name), f"{REFERENCE_DIR}/{name}"))',
    why: 'The release attaches a printable without Appendix A, and Release assets are immutable.',
  },
  {
    id: 'P-ii. ★★★ a blob/main link into a printed file stays external',
    file: BD,
    find: 'if path in self.files:',
    to: 'if False:  # MUTANT',
    why: 'The printed guide links out to GitHub for a page printed a few pages later.',
  },
  {
    id: 'P-iii. ★★★ a link whose fragment matches no heading does not fail the build',
    file: BD,
    find: 'self.errors.append(f"{src.where(line)}: {json.dumps(dest)} — #{frag} matches no heading in {target_rel}")',
    to: 'pass  # MUTANT',
    why: 'A dead link is sealed into the release printable.',
  },
  {
    id: 'P-iv. ★★ a link to a non-unique heading does not fail the build',
    file: BD,
    find: 'if not h.unique:',
    to: 'if False:  # MUTANT',
    why: 'The link lands on whichever same-named heading pandoc numbered first.',
  },
  {
    id: 'P-v. ★★ the frozen history is bundled',
    file: BD,
    find: '    for role, rel in plan:\n        if rel == HISTORY_DIR or rel.startswith(HISTORY_DIR + "/"):\n            raise BuildError(f"{rel}: the frozen history is not printed")',
    to: '    plan += [("part", f"{HISTORY_DIR}/{n}") for n in markdown_files(root, HISTORY_DIR)]  # MUTANT',
    why: 'The release log, superseded figures and all, is printed as if it were the reference.',
  },
  {
    id: 'P-vi. ★★ the synthetic "# Engineering reference" is omitted',
    file: BD,
    find: 'body = f"# {SYNTHETIC_H1} {{#{self.synthetic_id}}}\\n\\n{body}"',
    to: 'body = body  # MUTANT',
    why: 'The PDF outline puts the 19 chapters at the top level beside the guide.',
  },
  {
    id: 'P-vii. ★★ the GitHub alert marker is left in',
    file: BD,
    find: 'elif kind == "para" and self.alert(raw) and (n == 0 or not self.quoted(lines[n - 1])):',
    to: 'elif False:  # MUTANT',
    why: 'The printable shows a literal "[!WARNING]" where the heartbeat warning should be.',
  },
  {
    id: 'P-viii. ★★★ pandoc runs without --fail-if-warnings',
    file: BD,
    find: '"--fail-if-warnings",',
    to: '# MUTANT',
    why: 'A missing image or a duplicate id ships in the release printable instead of failing CI.',
  },
  {
    id: 'P-ix. ★★ pandoc runs without --resource-path',
    file: BD,
    find: 'f"--resource-path={repo_root}",',
    to: '# MUTANT',
    why: 'Images resolve against the working directory, so a release build from elsewhere drops them.',
  },
  {
    id: 'P-x. ★★★ the Python slugger keeps punctuation',
    file: BD,
    find: 'if cat[0] in "LM" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:',
    to: 'if cat[0] in "LMP" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:  # MUTANT',
    why: 'The printable\'s ids differ from GitHub\'s, so the links resolved against them do not match.',
  },
  {
    id: 'P-xi. ★★ a manifest entry with no file passes',
    file: BD,
    find: 'if name not in present:',
    to: 'if False:  # MUTANT',
    why: 'The build fails later with a bare "missing" instead of naming the manifest line.',
  },
  {
    id: 'P-xii. ★★★ a reference file not in the manifest passes',
    file: BD,
    find: 'if name not in manifest:',
    to: 'if False:  # MUTANT',
    why: 'A new chapter file that nobody listed is silently left out of the printable.',
  },
  {
    id: 'P-xiii. ★★ a guide page not in GUIDE_PAGES passes',
    file: BD,
    find: 'if f"{GUIDE_DIR}/{name}" not in GUIDE_PAGES:',
    to: 'if False:  # MUTANT',
    why: 'A new operator page (alerts.md) is silently left out of the printable.',
  },
  {
    id: 'P-xiv. ★★ links to files that are not printed are not pinned to --ref',
    file: BD,
    find: "url = f\"{REPO_URL}/{kind}/{self.link_ref}/{quote(path, safe='/')}\"",
    to: "url = f\"{REPO_URL}/{kind}/main/{quote(path, safe='/')}\"  # MUTANT",
    why: 'The v1.188.0 printable links main, which drifts away from the version it describes.',
  },
  {
    id: 'P-xv. ★ no page break before a chapter',
    file: BD,
    find: 'pieces.append(PAGE_BREAK + body)',
    to: 'pieces.append("\\n\\n" + body)  # MUTANT',
    why: 'Chapters run on mid-page in the 400-page printable.',
  },
  {
    id: 'P-xvi. ★★ the Python slugger keeps superscripts, subscripts and fractions',
    file: BD,
    find: 'if cat[0] in "LM" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:',
    to: 'if cat[0] in "LMN" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:  # MUTANT',
    why: 'The printable\'s id for "Fit quality (R²)" differs from GitHub\'s and from the one D5 checked.',
  },
  {
    id: 'P-xvii. ★ the Python slugger drops the zero-width joiners',
    file: BD,
    find: 'if cat[0] in "LM" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:',
    to: 'if cat[0] in "LM" or cat in SLUG_KEEP_CATEGORIES:  # MUTANT',
    why: 'A heading with a joiner gets a printable id that the links resolved against GitHub\'s ids miss.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants (the checker's fixtures
// and whole-tree run, the builder's fixtures and whole-tree assembly, the manifest helper), so a
// kill comes from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1188-0', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
