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
 *       a missing, unlisted or unprinted file passing, links not pinned to --ref, no page breaks;
 *       1.209.1, the contents: the .docx's left empty, a heading without a bookmark linked
 *       nowhere, a quoted heading's bookmark unread, level 3 cached or level 2 dropped, the count
 *       unchecked against the Markdown (or the Markdown's widened), a field of another depth or a
 *       second one filled, the dirty flag dropped, an unfilled .docx left behind; and the PDF
 *       (build-docs-pdf.py): its count unchecked, the indexes not updated, the first start
 *       skipped or the profile made by hand (the first-start trap), the module unregistered, a
 *       missing report, an entry without a page number or with page 0 counted, level 3 counted
 *       or level 2 dropped, no field or two passing, a missing, empty or non-PDF file passing, a
 *       Basic error unquoted, an unlistable script.xlb, an unreadable or missing .docx unnamed,
 *       a stale PDF kept, the work directory kept, SIGTERM not unwound, LibreOffice outliving
 *       the run, soffice not looked for; and (review) the count taken from a field of another
 *       depth, from one with no cached entries, or unchecked against the Heading1/2 paragraphs, a
 *       nested field ending it or the body counted with it, pages that go back or never rise, no
 *       deadline of its own or one past the workflows' timeout, no SIGTERM before SIGKILL, a
 *       second signal cutting the cleanup short, a stop with no line, SIGINT unhandled, the
 *       caller's .docx loaded in place (its lock file left beside it), LibreOffice's TMPDIR not
 *       the work directory's, the .docx taken for the PDF, a missing or unwritable PDF directory
 *       unnamed, the stale PDF removed after the usage exits, the macro's handler cleaning up in
 *       error mode, a .docx that did not load unnamed, the depth unlike the builder's
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
const BP = resolve(REPO, 'scripts/build-docs-pdf.py');
const SUBSET = [
  'test/docsLayout.test.ts',
  'test/docsBuild.test.ts',
  'test/nightChargeMqtt.test.ts',
  'test/docsPdf.test.ts',
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
  /* ── P, 1.209.1: the contents of the .docx (build-docs-docx.py) ── */
  {
    id: 'P-xviii. ★★★ the .docx contents is left empty',
    file: BD,
    find: '        entries = fill_docx_toc(output, toc_heading_count(combined))',
    to: '        entries = []  # MUTANT',
    why: 'Every viewer but Word shows "Table of Contents" over nothing again.',
  },
  {
    id: 'P-xix. ★★★ a heading with no bookmark gets an entry that links nowhere',
    file: BD,
    find: '            b = DOCX_BOOKMARK_BEFORE.search(gap) or DOCX_BOOKMARK_INSIDE.search(p.group(0))',
    to: '            b = DOCX_BOOKMARK_BEFORE.search(gap) or DOCX_BOOKMARK_INSIDE.search(p.group(0)) or re.match("()", "")  # MUTANT',
    why: 'A contents entry with an empty anchor is sealed into the release .docx.',
  },
  {
    id: 'P-xx. ★★ a quoted or listed heading\'s bookmark is not read',
    file: BD,
    find: '            b = DOCX_BOOKMARK_BEFORE.search(gap) or DOCX_BOOKMARK_INSIDE.search(p.group(0))',
    to: '            b = DOCX_BOOKMARK_BEFORE.search(gap)  # MUTANT',
    why: 'A heading in a quote or a list item (pandoc puts its bookmark inside the paragraph) fails the build.',
  },
  {
    id: 'P-xxi. ★★ the .docx contents lists level-3 headings too',
    file: BD,
    find: '        if level <= TOC_DEPTH:',
    to: '        if level <= TOC_DEPTH + 1:  # MUTANT',
    why: 'The cached list is not the one Word builds from the field (\\o "1-2"), and grows by 188 entries.',
  },
  {
    id: 'P-xxii. ★★ the .docx contents leaves level-2 headings out',
    file: BD,
    find: '        if level <= TOC_DEPTH:',
    to: '        if level < TOC_DEPTH:  # MUTANT',
    why: 'The contents lists the seven parts and none of their sections.',
  },
  {
    id: 'P-xxiii. ★★★ the cached entries are not counted against the Markdown\'s headings',
    file: BD,
    find: '    if len(entries) != expected:',
    to: '    if False:  # MUTANT',
    why: 'A heading pandoc did not write as a heading drops out of the contents silently.',
  },
  {
    id: 'P-xxiv. ★★ the Markdown count takes level-3 headings too',
    file: BD,
    find: '    return sum(1 for h in scan_markdown(markdown).headings if h.level <= TOC_DEPTH)',
    to: '    return sum(1 for h in scan_markdown(markdown).headings if h.level <= TOC_DEPTH + 1)  # MUTANT',
    why: 'Every build fails on a count the contents was never meant to reach.',
  },
  {
    id: 'P-xxv. ★★ a TOC field of another depth is filled with level-1 and level-2 entries',
    file: BD,
    find: '    if int(field.group(2)) != TOC_DEPTH:',
    to: '    if False:  # MUTANT',
    why: 'The cached list disagrees with the one Word rebuilds from the field.',
  },
  {
    id: 'P-xxvi. ★ a second TOC field passes and only the first is filled',
    file: BD,
    find: '    if len(fields) != 1:',
    to: '    if not fields:  # MUTANT',
    why: 'A second, empty contents is shipped beside the filled one.',
  },
  {
    id: 'P-xxvii. ★★ the field loses its dirty flag',
    file: BD,
    find: '    field_start = (\'<w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /></w:r>\'',
    to: '    field_start = (\'<w:r><w:fldChar w:fldCharType="begin" /></w:r>\'  # MUTANT',
    why: 'Word no longer offers to rebuild the contents with page numbers.',
  },
  {
    id: 'P-xxviii. ★ a .docx whose contents could not be filled is left behind',
    file: BD,
    find: '        # a .docx whose contents could not be filled is not left behind to be attached\n        output.unlink(missing_ok=True)',
    to: '        # a .docx whose contents could not be filled is not left behind to be attached\n        pass  # MUTANT',
    why: 'A failed build leaves pandoc\'s empty-contents .docx where the upload and a local reader find it.',
  },
  /* ── P, 1.209.1: the PDF (build-docs-pdf.py) ── */
  {
    id: 'P-xxix. ★★★ the PDF\'s contents is not counted against the entries cached in the .docx',
    file: BP,
    find: '    if len(pages) != expected:',
    to: '    if False:  # MUTANT',
    why: 'Exit 0 with an empty table of contents: the defect itself.',
  },
  {
    id: 'P-xxx. ★★★ the indexes are not updated before the export',
    file: BP,
    find: '      idx.getByIndex(i).update()',
    to: '      REM MUTANT',
    why: 'The PDF prints the cached entries with no page numbers (or, from an older .docx, nothing).',
  },
  {
    id: 'P-xxxi. ★★ the macro leaves LibreOffice running after the report',
    file: BP,
    find: '  StarDesktop.terminate()\nEnd Sub\n',
    to: '  REM MUTANT\nEnd Sub\n',
    why: 'Where a headless office does not exit once its last document closes, every render runs into the deadline.',
  },
  {
    id: 'P-xxxii. ★★★ LibreOffice is not started once before the module is written',
    file: BP,
    find: '    first_start, _ = run_libreoffice(binary, work, deadline, "making its profile (its first start)", "--terminate_after_init")',
    to: '    first_start = 0  # MUTANT',
    why: 'There is no profile to register the module in: every render fails.',
  },
  {
    id: 'P-xxxiii. ★★★ the profile is made by hand instead of by a first start (the first-start trap)',
    file: BP,
    find: '    first_start, _ = run_libreoffice(binary, work, deadline, "making its profile (its first start)", "--terminate_after_init")',
    to: '    (work / "profile" / "user" / "basic" / "Standard").mkdir(parents=True); (work / "profile" / "user" / "basic" / "Standard" / "script.xlb").write_text("<library:library>\\n</library:library>\\n"); first_start = 0  # MUTANT',
    why: 'LibreOffice\'s first start rewrites script.xlb, the macro is not registered and nothing runs.',
  },
  {
    id: 'P-xxxiv. ★★★ the module is not registered in script.xlb',
    file: BP,
    find: '    xlb.write_text(text.replace("</library:library>", entry + "</library:library>", 1), encoding="utf-8")',
    to: '    pass  # MUTANT',
    why: 'LibreOffice does not find DocsPdf.Convert, does nothing and exits 0.',
  },
  {
    id: 'P-xxxv. ★ a script.xlb the module cannot be listed in is not named',
    file: BP,
    find: '    if "</library:library>" not in text:',
    to: '    if False:  # MUTANT',
    why: 'The module is written but never listed, and the failure says only that the macro did not run.',
  },
  {
    id: 'P-xxxvi. ★★ a missing report is not named',
    file: BP,
    find: '    if not report.is_file():',
    to: '    if False:  # MUTANT',
    why: 'A macro that never ran ends in a traceback rather than the line that says so.',
  },
  {
    id: 'P-xxxvii. ★★★ an entry without a page number counts',
    file: BP,
    find: '            if m:\n                pages.append(int(m.group(1)))',
    to: '            pages.append(int(m.group(1)) if m else 1)  # MUTANT',
    why: 'A contents printed from the cached entries, never updated, passes.',
  },
  {
    id: 'P-xxxviii. ★★ page 0 counts as a page number',
    file: BP,
    find: 'PAGED_ENTRY = re.compile(r"[^\\t]*\\t([1-9][0-9]*)")',
    to: 'PAGED_ENTRY = re.compile(r"[^\\t]*\\t([0-9]+)")  # MUTANT',
    why: 'Cached PAGEREF fields that LibreOffice never evaluated (each "0") pass.',
  },
  {
    id: 'P-xxxix. ★★ the PDF\'s heading count takes level-3 headings too',
    file: BP,
    find: '    headings = sum(1 for level in HEADING_STYLE.findall(xml) if 1 <= int(level) <= TOC_DEPTH)',
    to: '    headings = sum(1 for level in HEADING_STYLE.findall(xml) if 1 <= int(level) <= TOC_DEPTH + 1)  # MUTANT',
    why: 'Every correct .docx fails before LibreOffice starts.',
  },
  {
    id: 'P-xl. ★★ the PDF\'s heading count leaves level-2 headings out',
    file: BP,
    find: '    headings = sum(1 for level in HEADING_STYLE.findall(xml) if 1 <= int(level) <= TOC_DEPTH)',
    to: '    headings = sum(1 for level in HEADING_STYLE.findall(xml) if 1 <= int(level) < TOC_DEPTH)  # MUTANT',
    why: 'Every correct .docx fails; one whose cached entries are the seven parts alone would pass.',
  },
  {
    id: 'P-xli. ★★ a .docx with two TOC fields passes',
    file: BP,
    find: '    if len(instructions) != 1:',
    to: '    if not instructions:  # MUTANT',
    why: 'The count is taken against one field while LibreOffice reports both.',
  },
  {
    id: 'P-xlii. ★★ a missing or empty PDF passes the size check',
    file: BP,
    find: '    if not pdf.is_file() or pdf.stat().st_size == 0:',
    to: '    if False:  # MUTANT',
    why: 'A render that wrote nothing ends in a traceback or a misleading line.',
  },
  {
    id: 'P-xliii. ★ a file that is not a PDF passes',
    file: BP,
    find: '        if f.read(5) != b"%PDF-":',
    to: '        if False:  # MUTANT',
    why: 'An error page written under the PDF\'s name is uploaded as the PDF.',
  },
  {
    id: 'P-xliv. ★ a Basic error in the macro is not quoted',
    file: BP,
    find: '    if text.startswith("error "):',
    to: '    if False:  # MUTANT',
    why: 'The failure says no PDF was written, not why.',
  },
  {
    id: 'P-xlv. ★★ a PDF from an earlier run stays at the output path',
    file: BP,
    find: '    try:\n        output.unlink(missing_ok=True)\n    except OSError as e:',
    to: '    try:\n        pass  # MUTANT\n    except OSError as e:',
    why: 'A failed render leaves the old PDF where the upload finds it.',
  },
  {
    id: 'P-xlvi. ★★ the work directory (profile, copy, report) is not removed',
    file: BP,
    find: '        shutil.rmtree(work, ignore_errors=True)',
    to: '        pass  # MUTANT',
    why: 'Every run leaves a LibreOffice profile and a copy of the .docx in the temporary directory.',
  },
  {
    id: 'P-xlvii. ★★★ SIGTERM from the caller\'s timeout is not unwound',
    file: BP,
    find: 'STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)',
    to: 'STOP_SIGNALS = (signal.SIGINT,)  # MUTANT',
    why: 'A timed-out render dies without its finally blocks: the work directory stays and LibreOffice runs on.',
  },
  {
    id: 'P-xlviii. ★★★ LibreOffice\'s process group is not killed on the way out',
    file: BP,
    find: '    signal_group(proc, signal.SIGKILL)\n    proc.wait()',
    to: '    pass  # MUTANT\n    proc.wait()',
    why: 'A LibreOffice that ignores SIGTERM holds the run until the caller kills it, work directory and all.',
  },
  {
    id: 'P-xlix. ★ a .docx that is not one ends in a traceback',
    file: BP,
    find: '    except (OSError, zipfile.BadZipFile, KeyError, UnicodeDecodeError) as e:',
    to: '    except ():  # MUTANT',
    why: 'A truncated .docx (a killed build) is reported as a Python traceback, not as what it is.',
  },
  {
    id: 'P-l. ★ a missing .docx is not named',
    file: BP,
    find: '    if not docx.is_file():',
    to: '    if False:  # MUTANT',
    why: 'A wrong path fails later, as an unreadable .docx, and with exit 1 rather than the usage exit 2.',
  },
  {
    id: 'P-li. ★ soffice is not looked for',
    file: BP,
    find: 'LIBREOFFICE_COMMANDS = ("libreoffice", "soffice")',
    to: 'LIBREOFFICE_COMMANDS = ("libreoffice",)  # MUTANT',
    why: 'The script cannot run where LibreOffice installs only soffice (macOS).',
  },
  /* ── P, 1.209.1 (review): the PDF's count from the .docx alone, its pages, its deadline, its stops ── */
  {
    id: 'P-lii. ★★★ a TOC field of another depth than 1-2 passes',
    file: BP,
    find: '    if depth != TOC_DEPTH:',
    to: '    if False:  # MUTANT',
    why: 'A `\\o "1-1"` field passes with the seven parts listed and 73 sections missing.',
  },
  {
    id: 'P-liii. ★★★ a field with no cached entries passes',
    file: BP,
    find: '    if cached == 0:',
    to: '    if False:  # MUTANT',
    why: 'A document with no headings passes with an empty contents: exit 0, "Table of Contents" over nothing.',
  },
  {
    id: 'P-liv. ★★★ the cached entries are not counted against the Heading1 and Heading2 paragraphs',
    file: BP,
    find: '    if headings != cached:',
    to: '    if False:  # MUTANT',
    why: 'Headings restyled as body text, or added after the build, pass a contents that does not list them.',
  },
  {
    id: 'P-lv. ★★ a field nested in the contents ends it',
    file: BP,
    find: '        if kind == "begin":\n            depth += 1',
    to: '        if kind == "begin":\n            pass  # MUTANT',
    why: 'A contents Word has updated (a PAGEREF in each entry) counts one entry.',
  },
  {
    id: 'P-lvi. ★★ the cached entries are counted to the end of the document, not of the field',
    file: BP,
    find: '                return None if result is None else xml[result:m.start()]',
    to: '                return None if result is None else xml[result:]  # MUTANT',
    why: 'Every link in the body counts as a contents entry.',
  },
  {
    id: 'P-lvii. ★★ page numbers that go back pass',
    file: BP,
    find: '        if pages[i] < pages[i - 1]:',
    to: '        if False:  # MUTANT',
    why: 'An index updated out of layout passes on its count.',
  },
  {
    id: 'P-lviii. ★★ a contents that ends on the page it starts passes',
    file: BP,
    find: '    if len(pages) > 1 and pages[-1] <= pages[0]:',
    to: '    if False:  # MUTANT',
    why: 'An update that never laid the pages out (every entry on one page) passes.',
  },
  {
    id: 'P-lix. ★★★ LibreOffice has no deadline of the script\'s own',
    file: BP,
    find: '            out, _ = proc.communicate(timeout=deadline.left())',
    to: '            out, _ = proc.communicate()  # MUTANT',
    why: 'A LibreOffice that does not end holds the step to the caller\'s timeout, which ends it with no reason given.',
  },
  {
    id: 'P-lx. ★★ the deadline outlasts the workflows\' timeout',
    file: BP,
    find: 'DEADLINE_SECONDS = 200',
    to: 'DEADLINE_SECONDS = 240',
    why: 'The caller\'s timeout fires first, and the step ends at exit 124 with nothing said.',
  },
  {
    id: 'P-lxi. ★★ LibreOffice gets SIGKILL with no SIGTERM first',
    file: BP,
    find: '    if proc.poll() is None:\n        signal_group(proc, signal.SIGTERM)',
    to: '    if proc.poll() is None:\n        pass  # MUTANT',
    why: 'LibreOffice is never asked to end, and every stop waits out the grace.',
  },
  {
    id: 'P-lxii. ★★ a second signal cuts the cleanup short',
    file: BP,
    find: '    for s in STOP_SIGNALS:\n        signal.signal(s, signal.SIG_IGN)',
    to: '    pass  # MUTANT',
    why: 'A second SIGTERM during the grace skips the SIGKILL, and a LibreOffice that ignores SIGTERM runs on.',
  },
  {
    id: 'P-lxiii. ★★ a stop prints no line',
    file: BP,
    find: '    print(f"build-docs-pdf: stopped by {signal.Signals(signum).name} after {PROGRESS.seconds()} s, while {PROGRESS.doing}",\n          file=sys.stderr)',
    to: '    pass  # MUTANT',
    why: 'A run the caller\'s timeout stopped ends with nothing on stderr.',
  },
  {
    id: 'P-lxiv. ★★ SIGINT is not handled',
    file: BP,
    find: 'STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)',
    to: 'STOP_SIGNALS = (signal.SIGTERM,)  # MUTANT',
    why: 'Ctrl-C ends in a KeyboardInterrupt traceback, raised again inside the cleanup.',
  },
  {
    id: 'P-lxv. ★★★ the macro loads the caller\'s .docx, not a copy in the work directory',
    file: BP,
    find: '    macro = f\'macro:///Standard.{MODULE}.Convert("{source.as_uri()}","{pdf.as_uri()}","{report.as_uri()}")\'',
    to: '    macro = f\'macro:///Standard.{MODULE}.Convert("{docx.as_uri()}","{pdf.as_uri()}","{report.as_uri()}")\'  # MUTANT',
    why: 'A stopped run leaves LibreOffice\'s lock file beside the .docx, and every later run on that file waits for it.',
  },
  {
    id: 'P-lxvi. ★★ LibreOffice writes its temporary files to the caller\'s TMPDIR',
    file: BP,
    find: '        env=dict(os.environ, TMPDIR=str(work / "tmp")))',
    to: '        env=dict(os.environ))  # MUTANT',
    why: 'A stopped run leaves LibreOffice\'s temporary entries behind.',
  },
  {
    id: 'P-lxvii. ★★ a PDF path that is the .docx itself is accepted',
    file: BP,
    find: '    if output == docx:',
    to: '    if False:  # MUTANT',
    why: 'A .docx named with a .pdf suffix is removed as the PDF of an earlier run.',
  },
  {
    id: 'P-lxviii. ★ a missing directory for the PDF is found only after the render',
    file: BP,
    find: '    if not output.parent.is_dir():',
    to: '    if False:  # MUTANT',
    why: 'A full render runs before the PDF has nowhere to go.',
  },
  {
    id: 'P-lxix. ★ a PDF that cannot be written ends in a traceback',
    file: BP,
    find: '    except (RenderError, OSError) as e:',
    to: '    except RenderError as e:  # MUTANT',
    why: 'An unwritable output directory is reported as a Python traceback.',
  },
  {
    id: 'P-lxx. ★★ the stale PDF is removed only after the usage exits',
    file: BP,
    find: '    try:\n        output.unlink(missing_ok=True)\n    except OSError as e:\n        return usage(f"{output}: the PDF already there cannot be removed ({e.strerror or e})")\n    if not docx.is_file():\n        return usage(f"{docx}: no such file")\n    binary = find_libreoffice()\n    if binary is None:\n        return usage("neither libreoffice nor soffice is on PATH (CI installs libreoffice-writer)")\n',
    to: '    if not docx.is_file():\n        return usage(f"{docx}: no such file")\n    binary = find_libreoffice()\n    if binary is None:\n        return usage("neither libreoffice nor soffice is on PATH (CI installs libreoffice-writer)")\n    output.unlink(missing_ok=True)  # MUTANT\n',
    why: 'An exit 2 leaves the PDF of an earlier run where a caller that goes on finds it.',
  },
  {
    id: 'P-lxxi. ★★ the macro\'s error handler cleans up while still in error mode',
    file: BP,
    find: '  Resume Done\n',
    to: '  WriteReport(reportUrl, report)\n  On Error Resume Next\n  doc.close(True)\n  StarDesktop.terminate()\n  Exit Sub\n',
    why: 'A failing call in the handler (doc.close on a document that never loaded) ends the Sub: LibreOffice runs on until the deadline.',
  },
  {
    id: 'P-lxxii. ★★ a .docx LibreOffice did not load is not named',
    file: BP,
    find: '  If IsNull(doc) Then\n    report = &quot;error LibreOffice did not load the .docx&quot; &amp; Chr(10)\n    GoTo Done\n  End If\n',
    to: '  REM MUTANT\n',
    why: 'A file LibreOffice cannot open is reported as "Object variable not set".',
  },
  {
    id: 'P-lxxiii. ★ the PDF is checked at another depth than the builder fills',
    file: BP,
    find: 'build-docs-docx.py\'s TOC_DEPTH.\nTOC_DEPTH = 2',
    to: 'build-docs-docx.py\'s TOC_DEPTH.\nTOC_DEPTH = 3  # MUTANT',
    why: 'Every .docx the builder writes fails before LibreOffice starts.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants (the checker's fixtures
// and whole-tree run, the builder's fixtures and whole-tree assembly, the manifest helper), so a
// kill comes from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1188-0', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
