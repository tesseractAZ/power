/**
 * v1.188.0 — the printable manual (the .docx CI builds on every PR and the release attaches, and
 * the .pdf LibreOffice renders from it) is assembled by scripts/build-docs-docx.py from a
 * manifest: README, the guide pages (GUIDE_PAGES), SECURITY, a synthetic "# Engineering reference"
 * with the reference index's preamble, then every file the index's chapter list names. The index's
 * list and moved-sections table and the frozen history are not printed. Release assets are
 * immutable, so a printable that silently lost a chapter, or kept a link that leads nowhere, would
 * be sealed for good: the builder fails instead, naming file:line.
 *
 * This file runs the builder with `python3 -I -B` (it never needs pandoc for these modes):
 *
 *   - on a mkdtemp fixture tree (removed in `finally`): the print order, the synthetic level-1
 *     heading with no other level-1 heading after it, the page breaks, alert conversion, every
 *     link rule (into a printed file → `#id`, whole file → its first heading, not printed →
 *     blob/<ref>, image paths kept), fenced text untouched, history left out; and one failing
 *     tree per rule (unresolved or non-unique target, missing / unlisted / doubly listed file,
 *     an unlisted guide page, an unclosed fence, a missing link target or image, a bad --ref);
 *   - the pandoc command line: --fail-if-warnings and --resource-path=<root>, and that the
 *     --list-sources / --assemble-only / --print-pandoc-argv modes run with no pandoc on PATH;
 *   - on the repository: the source list against the manifest and the reference directory, and
 *     the Python slugger against scripts/lib/markdownScan.mjs (the ids GitHub gives) on every
 *     printed heading;
 *   - 1.209.1, the contents: fill_toc on a document.xml shaped as pandoc writes it (one cached
 *     entry per level-1 and level-2 heading, linked to the heading's bookmark, level 2 indented, no
 *     page numbers, the field kept as Word stores it; a heading with no bookmark, a missing,
 *     doubled or other-depth field, or a count unlike the Markdown's fails); where pandoc is
 *     installed, a real build of the fixture (and a contents that cannot be filled leaves no .docx);
 *     where LibreOffice is installed too and starts, scripts/build-docs-pdf.py on that build and on
 *     a .docx LibreOffice cannot load (each skips cleanly without them, or where LibreOffice is
 *     installed but cannot start, as inside a command sandbox; CI's docs job runs both tools on
 *     the repository on every PR);
 *   - STAGED (enabled by the 1.188.0 release commit, like docsLayout's whole-tree tests): the
 *     repository's assembled document itself — at least 900,000 bytes, chapters 1–15 and
 *     Appendix A once each under the synthetic heading, no alert marker, no link left pointing at
 *     a printed file's path, every in-document link resolving exactly once, no history text.
 *     Until the consumers commit repoints the inbound links that still name the old single-file
 *     manual's anchors, the repository build exits 1 on exactly those links.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GITHUB_NUMBER_AND_JOINER_SLUGS } from './helpers/githubSlugCases.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILDER = join(ROOT, 'scripts', 'build-docs-docx.py');
const SCANNER = join(ROOT, 'scripts', 'lib', 'markdownScan.mjs');

interface Heading { line: number; level: number; raw: string; text: string; base: string; slug: string; setext: boolean }
interface Link { line: number; kind: string; image: boolean; dest: string }
interface Scan {
  headings: Heading[];
  links: Link[];
  paragraphs: { line: number; text: string }[];
  definitions: Map<string, string>;
  unclosedFence: number | null;
}
interface MarkdownScan {
  scanMarkdown(src: string): Scan;
  renderInlineText(text: string, definitions?: Map<string, string>): string;
  createSlugger(): (text: string) => string;
}
const ms = (await import(pathToFileURL(SCANNER).href)) as MarkdownScan;

/* ── running the builder ──────────────────────────────────────────────────── */

const PYTHON = (() => {
  const r = spawnSync('python3', ['-I', '-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python3 is required: ${r.stderr}`);
  return r.stdout.trim();
})();

function build(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(PYTHON, ['-I', '-B', BUILDER, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
}
const out = (r: SpawnSyncReturns<string>) => `exit ${r.status}\n${r.stdout.slice(0, 2000)}\n${r.stderr}`;

/* ── fixture paths and text, built so this file names no Markdown path that is not in the tree ── */

const D = 'docs';
const MD = '.md';
const GH = 'https://github.com/tesseractAZ/power';
const P = {
  readme: 'README' + MD,
  security: 'SECURITY' + MD,
  guide: 'ecoflow_panel/DOCS' + MD,
  yourHome: `${D}/guide/your-home${MD}`,
  options: `${D}/guide/options${MD}`,
  entities: `${D}/guide/entities${MD}`,
  index: `${D}/reference/README${MD}`,
  ref1: `${D}/reference/01-one${MD}`,
  ref21: `${D}/reference/02-1-two${MD}`,
  ref22: `${D}/reference/02-2-three${MD}`,
  refA: `${D}/reference/A-appendix${MD}`,
  hist: `${D}/history/old-log${MD}`,
  design: `${D}/design${MD}`,
  shot: `${D}/shot.png`,
  config: 'ecoflow_panel/config.yaml',
};
const BREAK = '```{=openxml}';
const PANDOC_FROM = 'markdown+task_lists+gfm_auto_identifiers';

type Files = Record<string, string | Buffer | null>;
const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

function baseFiles(): Files {
  return {
    [P.config]: lines('name: Power', 'version: "1.188.0"'),
    'LICENSE': lines('Licence text.'),
    [P.design]: lines('# Design note'),
    [P.shot]: 'not really a PNG; only its presence is checked here',
    [P.readme]: lines(
      '# Readme title',
      '',
      `The [guide](${P.guide}) and its [tariff options](${P.options}#tariff).`,
      `The [design note](${P.design}), the [licence](LICENSE), the [reference index](${P.index})`,
      `and [a reference section](${P.ref21}#wire-detail).`,
      '',
      '```md',
      `[a sample link](${P.guide})`,
      '# a sample heading',
      '```',
      '',
      `![a screenshot](${P.shot})`,
    ),
    [P.guide]: lines(
      '# Guide',
      '',
      '> [!WARNING]',
      '> Keep the host on an always-on circuit.',
      '',
      '## Setup',
      '',
      `See [the options](${GH}/blob/main/${P.options}), [the moved sections](${GH}/blob/main/${P.index}#moved-sections),`,
      `[section 1.1](${GH}/blob/main/${P.ref1}#11-first-section) and [the releases](${GH}/releases).`,
    ),
    [P.yourHome]: lines('# Your home', '', '## Time zone', '', 'Leave it empty.'),
    [P.options]: lines('# Options', '', '## Tariff', '', 'Rates.'),
    [P.entities]: lines('# Entities', '', '## Sensors', '', 'Values.'),
    [P.security]: lines('# Security', '', '## Reporting', '', `See [the bridge](${P.ref22}#bridge-section).`),
    [P.index]: lines(
      '# Reference index',
      '',
      'PREAMBLE-TEXT names [the guide](../../ecoflow_panel/DOCS' + MD + '), [the history](../history/) and [the options](../guide/options' + MD + ').',
      '',
      '## How this reference is organised',
      '',
      'Section numbers are chapter-local.',
      '',
      '## Chapters',
      '',
      '<!-- chapters:start -->',
      '- [1. One](01-one' + MD + ')',
      '- [2. Two, part 1](02-1-two' + MD + ')',
      '- [2. Two, part 2](02-2-three' + MD + ')',
      '- [Appendix A](A-appendix' + MD + ')',
      '<!-- chapters:end -->',
      '',
      '## Moved sections',
      '',
      'MOVED-TABLE-TEXT [one](01-one' + MD + '#1-one)',
    ),
    [P.ref1]: lines(
      '## 1. One',
      '',
      '### 1.1 First section',
      '',
      'See [the bridge](02-2-three' + MD + '#bridge-section) and [this section](#11-first-section).',
    ),
    [P.ref21]: lines(
      '## 2. Two',
      '',
      '### Wire detail',
      '',
      '~~~',
      '## 9. fenced, not a heading',
      '[fenced](01-one' + MD + ')',
      '~~~',
    ),
    [P.ref22]: lines('### Bridge section', '', 'The [old log](../history/old-log' + MD + ') moved.'),
    [P.refA]: lines('## Appendix A — Inventory', '', '> [!NOTE]', '> APPENDIX-NOTE.'),
    [P.hist]: lines('> [!NOTE]', '> HISTORY-MARKER, frozen.', '', '## Old release log'),
  };
}

function withFixture<T>(mutate: ((f: Files) => void) | undefined, fn: (dir: string) => T): T {
  const files = baseFiles();
  mutate?.(files);
  const dir = mkdtempSync(join(tmpdir(), 'docs-build-'));
  try {
    for (const [rel, c] of Object.entries(files)) {
      if (c === null) continue;
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const replace = (f: Files, rel: string, from: string, to: string) => {
  const t = String(f[rel]);
  assert.ok(t.includes(from), `fixture ${rel} lacks ${JSON.stringify(from)}`);
  f[rel] = t.replace(from, to);
};

/** Assemble a fixture tree; returns the Markdown (asserting exit 0). */
function assembleFixture(mutate?: (f: Files) => void, extra: string[] = []): string {
  return withFixture(mutate, (dir) => {
    const r = build(['--repo-root', dir, '--assemble-only', ...extra]);
    assert.equal(r.status, 0, out(r));
    return r.stdout;
  });
}

/** Assemble a fixture tree that must fail; returns stderr (asserting exit 1). */
function failFixture(mutate: (f: Files) => void, mode = '--assemble-only'): string {
  return withFixture(mutate, (dir) => {
    const r = build(['--repo-root', dir, mode]);
    assert.equal(r.status, 1, out(r));
    assert.equal(r.stdout, '', 'a failed build writes no document');
    return r.stderr;
  });
}

/* ── checks every assembled document must pass ────────────────────────────── */

const ID_SUFFIX = / \{#([^\s{}]+)\}$/;

/**
 * Every heading carries ` {#id}` and the id is what markdownScan.mjs's (GitHub's) slugger gives
 * its text in the merged document; every `#x` link names exactly one id; no link but an image is
 * relative; no repository link points at a printed file; no alert marker is left.
 */
function checkAssembled(md: string, printed: string[]): Scan {
  const scan = ms.scanMarkdown(md);
  assert.equal(scan.unclosedFence, null, 'the assembled document leaves a fence open');
  const slug = ms.createSlugger();
  const ids = new Map<string, number>();
  for (const h of scan.headings) {
    const m = ID_SUFFIX.exec(h.raw);
    assert.ok(m, `heading at line ${h.line} has no explicit id: ${h.raw}`);
    const text = ms.renderInlineText(h.raw.slice(0, m.index), scan.definitions).trim();
    assert.equal(m[1], slug(text), `Python and Node disagree on the id of "${text}" (line ${h.line})`);
    ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
  }
  const blobPrefixes = printed.flatMap((rel) => [`${GH}/blob/`, `${GH}/tree/`].map((p) => ({ p, rel })));
  for (const l of scan.links) {
    if (l.dest.startsWith('#')) {
      assert.equal(ids.get(l.dest.slice(1)), 1, `line ${l.line}: ${l.dest} does not name exactly one heading`);
      continue;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(l.dest)) {
      assert.ok(l.image, `line ${l.line}: relative link ${l.dest} survived into the printable`);
      continue;
    }
    for (const { p, rel } of blobPrefixes) {
      if (!l.dest.startsWith(p)) continue;
      const path = l.dest.slice(p.length).split('#')[0].split('/').slice(1).join('/');
      assert.notEqual(path, rel, `line ${l.line}: ${l.dest} links a printed file out of the document`);
    }
  }
  assert.doesNotMatch(md, /^ {0,3}>[ \t]?\[![A-Za-z]+\][ \t]*$/m, 'a GitHub alert marker survived');
  return scan;
}

/* ── the fixture ──────────────────────────────────────────────────────────── */

test('--list-sources prints the print order: README, the guide pages, SECURITY, the index preamble, the manifest', () => {
  withFixture(undefined, (dir) => {
    const r = build(['--repo-root', dir, '--list-sources']);
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.split('\t')), [
      ['readme', P.readme],
      ['guide', P.guide],
      ['guide', P.yourHome],
      ['guide', P.options],
      ['guide', P.entities],
      ['security', P.security],
      ['preamble', P.index],
      ['chapter', P.ref1],
      ['chapter', P.ref21],
      ['part', P.ref22],
      ['chapter', P.refA],
    ]);
  });
});

test('the assembled fixture: parts in order under one synthetic "# Engineering reference", page breaks before each chapter start', () => {
  const md = assembleFixture();
  const scan = checkAssembled(md, [P.readme, P.guide, P.yourHome, P.options, P.entities, P.security, P.ref1, P.ref21, P.ref22, P.refA]);
  const order = ['# Readme title', '# Guide', '# Your home', '# Options', '# Entities', '# Security', '# Engineering reference', '## 1. One', '## 2. Two', '### Bridge section', '## Appendix A'];
  const at = order.map((h) => (md.startsWith(h) ? 0 : md.indexOf(`\n${h}`)));
  for (let i = 0; i < at.length; i++) assert.ok(at[i] >= 0 && (i === 0 || at[i] > at[i - 1]), `${order[i]} is missing or out of order`);
  const h1 = scan.headings.filter((h) => h.level === 1).map((h) => h.raw.replace(ID_SUFFIX, ''));
  assert.deepEqual(h1, ['Readme title', 'Guide', 'Your home', 'Options', 'Entities', 'Security', 'Engineering reference']);
  // a page break before each of: guide, your home, options, entities, security, the reference, chapters 1, 2, A
  assert.equal(md.split(BREAK).length - 1, 9);
  const between = (a: string, b: string) => md.slice(md.indexOf(a), md.indexOf(b));
  assert.ok(!between('## 2. Two', '### Bridge section').includes(BREAK), 'a later part continues its chapter without a page break');
  assert.ok(between('# Engineering reference', '## 1. One').includes(BREAK), 'chapter 1 starts on a new page');
  assert.ok(between('### Bridge section', '## Appendix A').includes(BREAK), 'the appendix starts on a new page');
});

test('the assembled fixture: the index preamble is printed, its chapter list and moved-sections table and the history are not', () => {
  const md = assembleFixture();
  assert.match(md, /^# Engineering reference \{#engineering-reference\}\n\nPREAMBLE-TEXT names/m);
  assert.match(md, /^## How this reference is organised \{#/m);
  for (const absent of ['Reference index', '## Chapters', 'chapters:start', 'MOVED-TABLE-TEXT', 'HISTORY-MARKER', 'Old release log']) {
    assert.ok(!md.includes(absent), `${JSON.stringify(absent)} was printed`);
  }
});

test('the assembled fixture: GitHub alerts become a bold label in a plain blockquote', () => {
  const md = assembleFixture();
  assert.match(md, /^> \*\*Warning\.\*\*\n> Keep the host on an always-on circuit\.$/m);
  assert.match(md, /^> \*\*Note\.\*\*\n> APPENDIX-NOTE\.$/m);
  assert.ok(!md.includes('[!'), 'an alert marker survived');
});

test('the assembled fixture: links into printed files become #ids; a whole-file link goes to its first heading', () => {
  const md = assembleFixture();
  for (const want of [
    '[the guide](#guide)',                    // README → whole file
    '[tariff options](#tariff)',              // README → file#fragment
    '[a reference section](#wire-detail)',    // README → reference chapter
    '[the options](#options)',                // guide: absolute blob/main URL to a printed file
    '[section 1.1](#11-first-section)',       // guide: absolute URL with a fragment
    '[the bridge](#bridge-section)',          // SECURITY and chapter 1 → a part-2 file
    '[this section](#11-first-section)',      // an in-file #link
  ]) assert.ok(md.includes(want), `missing ${want}`);
  assert.ok(md.includes('names [the guide](#guide), '), 'the preamble\'s relative link to the guide');
  assert.ok(md.includes(' and [the options](#options).'), 'the preamble\'s relative link to the options page');
});

test('the assembled fixture: links to files that are not printed open the built ref on GitHub; images keep a root path', () => {
  const local = assembleFixture();
  for (const want of [
    `[design note](${GH}/blob/main/${P.design})`,
    `[licence](${GH}/blob/main/LICENSE)`,
    `[reference index](${GH}/blob/main/${P.index})`,
    `[the moved sections](${GH}/blob/main/${P.index}#moved-sections)`,
    `[the history](${GH}/tree/main/docs/history)`,
    `[old log](${GH}/blob/main/${P.hist})`,
    `[the releases](${GH}/releases)`,
    `![a screenshot](${P.shot})`,
  ]) assert.ok(local.includes(want), `missing ${want}`);
  const tagged = assembleFixture(undefined, ['--ref', 'v1.188.0']);
  assert.ok(tagged.includes(`[design note](${GH}/blob/v1.188.0/${P.design})`), 'a release build links its own tag');
  assert.ok(tagged.includes(`[the moved sections](${GH}/blob/v1.188.0/${P.index}#moved-sections)`), 'an absolute main link is pinned to the built ref');
  assert.ok(tagged.includes(`[the releases](${GH}/releases)`));
  assert.ok(!tagged.includes('/blob/main/'), 'a release build left a main link');
});

test('the assembled fixture: text inside fences is never rewritten or read as a heading', () => {
  const md = assembleFixture();
  assert.ok(md.includes(`\n[a sample link](${P.guide})\n# a sample heading\n`), 'fenced README sample changed');
  assert.ok(md.includes('\n## 9. fenced, not a heading\n[fenced](01-one' + MD + ')\n'), 'fenced reference sample changed');
});

/* ── the builder fails, naming file:line ──────────────────────────────────── */

test('fails on a link whose fragment matches no heading in the printed target', () => {
  const err = failFixture((f) => replace(f, P.readme, `${P.options}#tariff`, `${P.options}#no-such-heading`));
  assert.match(err, /^build-docs-docx: README\.md:3: .*#no-such-heading matches no heading in docs\/guide\/options\.md$/m);
});

test('fails on a link whose target heading is not unique in the merged document', () => {
  const err = failFixture((f) => replace(f, P.entities, '## Sensors', '## Tariff'));
  assert.match(err, /^build-docs-docx: README\.md:3: .*"Tariff" \(docs\/guide\/options\.md:3\) does not have a unique id/m);
});

test('fails when the manifest lists a missing file, a file twice, or misses a reference file', () => {
  assert.match(failFixture((f) => { f[P.ref22] = null; }), /lists 02-2-three\.md, which is missing/);
  assert.match(failFixture((f) => { f[P.ref22] = null; }, '--list-sources'), /lists 02-2-three\.md, which is missing/);
  assert.match(failFixture((f) => replace(f, P.index, '- [Appendix A]', '- [1. One again](01-one' + MD + ')\n- [Appendix A]')),
    /README\.md:\d+: 01-one\.md is listed twice/);
  assert.match(failFixture((f) => { f[`${D}/reference/03-extra${MD}`] = lines('## 3. Extra'); }), /03-extra\.md: not listed in the manifest/);
  assert.match(failFixture((f) => replace(f, P.index, '<!-- chapters:end -->', 'chapters end')), /no <!-- chapters:start --> … <!-- chapters:end --> manifest/);
});

test('fails on a guide page that GUIDE_PAGES does not print, and on a missing fixed part', () => {
  assert.match(failFixture((f) => { f[`${D}/guide/alerts${MD}`] = lines('# Alerts'); }), /alerts\.md: a guide page not in GUIDE_PAGES/);
  assert.match(failFixture((f) => { f[P.security] = null; }), /^build-docs-docx: SECURITY\.md: missing/m);
  assert.match(failFixture((f) => { f[P.options] = null; }), /^build-docs-docx: docs\/guide\/options\.md: missing/m);
});

test('fails on an unclosed fence, a missing link target, a missing image and a malformed --ref', () => {
  assert.match(failFixture((f) => { f[P.ref1] += '\n```\nnever closed\n'; }), /01-one\.md:7: code fence opened here is never closed/);
  assert.match(failFixture((f) => replace(f, P.readme, '(LICENSE)', `(${D}/gone${MD})`)), /README\.md:4: .*docs\/gone\.md does not exist/);
  assert.match(failFixture((f) => { f[P.shot] = null; }), /README\.md:12: image .*is not a file in the repository/);
  withFixture(undefined, (dir) => {
    const r = build(['--repo-root', dir, '--assemble-only', '--ref', 'v1 .188']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /--ref "v1 \.188": not a tag, branch or SHA/);
  });
});

/* ── the pandoc command line, and the modes that need no pandoc ───────────── */

test('--print-pandoc-argv: the markdown reader, --fail-if-warnings and --resource-path=<repo root>', () => {
  withFixture(undefined, (dir) => {
    const r = build(['--repo-root', dir, '--print-pandoc-argv', '--output', join(dir, 'out.docx')]);
    assert.equal(r.status, 0, out(r));
    const argv = JSON.parse(r.stdout) as string[];
    assert.equal(argv[0], 'pandoc');
    assert.ok(argv.includes('--fail-if-warnings'), 'warnings must fail the build');
    assert.ok(argv.includes(`--resource-path=${realpathSync(dir)}`), `no --resource-path=<root> in ${argv.join(' ')}`);
    assert.equal(argv[argv.indexOf('-f') + 1], PANDOC_FROM);
    assert.ok(argv.includes('--toc'));
    assert.ok(argv.includes(join(realpathSync(dir), 'out.docx')));
  });
});

test('--list-sources, --assemble-only and --print-pandoc-argv run with no pandoc on PATH; a real build then exits 2', () => {
  withFixture(undefined, (dir) => {
    const empty = mkdtempSync(join(tmpdir(), 'docs-build-path-'));
    try {
      const env = { PATH: empty, HOME: empty, LANG: 'C.UTF-8' };
      for (const mode of ['--list-sources', '--assemble-only', '--print-pandoc-argv']) {
        const r = build(['--repo-root', dir, mode], env);
        assert.equal(r.status, 0, `${mode}: ${out(r)}`);
      }
      const r = build(['--repo-root', dir, '--output', join(dir, 'x.docx')], env);
      assert.equal(r.status, 2, out(r));
      assert.match(r.stderr, /pandoc not found on PATH/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

/* ── the repository ───────────────────────────────────────────────────────── */

const REFERENCE_DIR = join(ROOT, D, 'reference');

test('the repository: the printed sources are README, the guide pages, SECURITY, the index preamble and all 21 reference files in manifest order', () => {
  const r = build(['--list-sources']);
  assert.equal(r.status, 0, out(r));
  const rows = r.stdout.trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows.slice(0, 7), [
    ['readme', P.readme], ['guide', P.guide], ['guide', P.yourHome], ['guide', P.options], ['guide', P.entities], ['security', P.security], ['preamble', P.index],
  ]);
  const refs = rows.slice(7).map(([, rel]) => rel);
  const onDisk = readdirSync(REFERENCE_DIR).filter((n) => n.endsWith(MD) && n !== 'README' + MD).sort().map((n) => `${D}/reference/${n}`);
  assert.equal(refs.length, 21);
  assert.deepEqual(refs, onDisk, 'the manifest is in file-name order and names every reference file');
  for (const [role, rel] of rows.slice(7)) {
    assert.equal(role, /\/\d\d-[2-9]-/.test(rel) ? 'part' : 'chapter', `${rel} is a ${role}`);
  }
  assert.ok(!rows.some(([, rel]) => rel.startsWith(`${D}/history/`)), 'the history is not printed');
});

test('the repository: the Python slugger gives every printed heading the id markdownScan.mjs (GitHub) gives it', () => {
  const code = [
    'import importlib.util, json, sys',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("build_docs", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'd = m.Document(Path(sys.argv[2]), "main")',
    'print(json.dumps({"synthetic": d.synthetic_id, "sources": [{"rel": s.rel, "role": s.role,',
    '  "text": s.text if s.role == "preamble" else None,',
    '  "headings": [[h.line, h.level, h.text, h.slug, h.id] for h in s.scan.headings]} for s in d.sources]}))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, BUILDER, ROOT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, out(r));
  const py = JSON.parse(r.stdout) as { synthetic: string; sources: { rel: string; role: string; text: string | null; headings: [number, number, string, string, string][] }[] };
  const merged = ms.createSlugger();
  let n = 0;
  for (const s of py.sources) {
    if (s.role === 'preamble') assert.equal(py.synthetic, merged('Engineering reference'));
    const scan = ms.scanMarkdown(s.text ?? readFileSync(join(ROOT, s.rel), 'utf8'));
    assert.deepEqual(s.headings.map(([line, level, text, slug]) => [line, level, text, slug]),
      scan.headings.map((h) => [h.line, h.level, h.text, h.slug]), `${s.rel}: headings or per-file slugs differ`);
    for (const [line, , text, , id] of s.headings) {
      assert.equal(id, merged(text), `${s.rel}:${line}: merged-document id differs`);
      n++;
    }
  }
  assert.ok(n > 600, `only ${n} printed headings`);
});

test('the Python slugger gives the ids GitHub gives: other numbers deleted, digits, letter numbers and joiners kept', () => {
  // against GitHub's own ids, not only against markdownScan.mjs: two sluggers that make the same
  // mistake agree with each other, and D5 would then accept a fragment that is dead on GitHub
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("build_docs", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps([m.github_slug(t) for t in json.loads(sys.stdin.buffer.read().decode("utf-8"))]))',
  ].join('\n');
  const headings = GITHUB_NUMBER_AND_JOINER_SLUGS.map(([h]) => h);
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, BUILDER], { encoding: 'utf8', input: JSON.stringify(headings) });
  assert.equal(r.status, 0, out(r));
  const py = JSON.parse(r.stdout) as string[];
  GITHUB_NUMBER_AND_JOINER_SLUGS.forEach(([heading, id], i) => {
    assert.equal(py[i], id, `Python: ${JSON.stringify(heading)}`);
    assert.equal(ms.createSlugger()(heading), id, `Node: ${JSON.stringify(heading)}`);
  });
});

function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
const ADDON_VERSION = /^version:\s*"?([^"#\s]+)"?/m.exec(readFileSync(join(ROOT, P.config), 'utf8'))?.[1] ?? '0.0.0';
const WHOLE_TREE: string | false = versionAtLeast(ADDON_VERSION, '1.188.0')
  ? false
  : `staged until the 1.188.0 release commit (config.yaml is ${ADDON_VERSION}): the inbound links into the old single-file manual are repointed by the consumers commit`;

test('the repository assembles: ≥ 900,000 bytes, chapters 1–15 and Appendix A once each under "# Engineering reference", every link resolved, no history', { skip: WHOLE_TREE }, () => {
  const r = build(['--assemble-only']);
  assert.equal(r.status, 0, out(r));
  const md = r.stdout;
  assert.ok(Buffer.byteLength(md) >= 900_000, `the assembled printable is ${Buffer.byteLength(md)} bytes`);
  const sources = build(['--list-sources']).stdout.trim().split('\n').map((l) => l.split('\t')[1]);
  const scan = checkAssembled(md, sources.filter((rel) => rel !== P.index));
  // parts in order: each printed file's first heading appears, in source order
  let last = -1;
  for (const rel of sources) {
    const src = rel === P.index ? null : readFileSync(join(ROOT, rel), 'utf8');
    if (!src) continue;
    const first = ms.scanMarkdown(src).headings[0];
    const at = scan.headings.findIndex((h, i) => i > last && h.raw.replace(ID_SUFFIX, '') === first.raw);
    assert.ok(at > last, `${rel}'s first heading "${first.raw}" is missing or out of order`);
    last = at;
  }
  const synthetic = scan.headings.findIndex((h) => h.level === 1 && h.raw === 'Engineering reference {#engineering-reference}');
  assert.ok(synthetic >= 0, 'no synthetic "# Engineering reference"');
  assert.ok(!scan.headings.slice(synthetic + 1).some((h) => h.level === 1), 'a level-1 heading inside the engineering reference');
  const chapters = scan.headings.filter((h) => h.level === 2 && (/^\d+\. /.test(h.raw) || h.raw.startsWith('Appendix A')));
  const numbers = chapters.map((h) => (h.raw.startsWith('Appendix A') ? 'A' : h.raw.split('.')[0]));
  assert.deepEqual(numbers, [...Array.from({ length: 15 }, (_, i) => String(i + 1)), 'A']);
  for (const h of chapters) assert.ok(scan.headings.indexOf(h) > synthetic, `${h.raw} is not under the synthetic heading`);
  // no history text: none of its headings, none of its paragraphs
  const headingTexts = new Set(scan.headings.map((h) => h.raw.replace(ID_SUFFIX, '')));
  for (const name of readdirSync(join(ROOT, D, 'history')).filter((n) => n.endsWith(MD))) {
    const hist = ms.scanMarkdown(readFileSync(join(ROOT, D, 'history', name), 'utf8'));
    for (const h of hist.headings) assert.ok(!headingTexts.has(h.raw), `history heading "${h.raw}" (${name}) was printed`);
    for (const p of hist.paragraphs) if (p.text.length >= 40) assert.ok(!md.includes(p.text), `history text from ${name}:${p.line} was printed`);
  }
});

/* ── 1.209.1: the contents ────────────────────────────────────────────────── */
// pandoc writes the TOC as an empty field, which only Word fills (it asks first): every viewer
// but Word, and the release PDF, showed "Table of Contents" over nothing. The builder caches one
// entry per level-1 and level-2 heading in it.

const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const TOC_INSTR = 'TOC \\o &quot;1-2&quot; \\h \\z \\u';
const tocField = (instr = TOC_INSTR) =>
  `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /><w:instrText xml:space="preserve">${instr}</w:instrText>`
  + '<w:fldChar w:fldCharType="separate" /><w:fldChar w:fldCharType="end" /></w:r></w:p>';
const tocBlock = (fields: string) =>
  '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents" /><w:docPartUnique /></w:docPartObj></w:sdtPr>'
  + '<w:sdtContent><w:p><w:pPr><w:pStyle w:val="TOCHeading" /></w:pPr><w:r><w:t xml:space="preserve">Table of Contents</w:t></w:r></w:p>'
  + `${fields}</w:sdtContent></w:sdt>`;
let bookmarkId = 100;
/** A heading as pandoc writes it: its bookmark directly before the paragraph (`inside`: first in it, as in a quote). */
function wHeading(level: number, runs: string, bookmark: string | null, inside = false): string {
  const mark = bookmark ? `<w:bookmarkStart w:id="${bookmarkId++}" w:name="${bookmark}" />` : '';
  return inside
    ? `\n    <w:p><w:pPr><w:pStyle w:val="Heading${level}" /></w:pPr>${mark}${runs}</w:p>`
    : `\n    ${mark}\n    <w:p><w:pPr><w:pStyle w:val="Heading${level}" /></w:pPr>${runs}</w:p>`;
}
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const BODY_PARA = '\n    <w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr><w:r><w:t xml:space="preserve">Text.</w:t></w:r><w:r><w:tab /></w:r></w:p>';

/** A document.xml: title, the TOC block, then the headings given. */
function wDocument(headings: string[], fields = tocField()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<w:document ${WNS}>\n<w:body>\n    <w:p><w:pPr><w:pStyle w:val="Title" /></w:pPr>${run('Manual')}</w:p>\n    `
    + tocBlock(fields) + headings.map((h) => h + BODY_PARA).join('') + '\n  </w:body>\n</w:document>';
}

/** The document every fill case starts from: levels 1, 2 (one with code and an entity), 3, and a quoted 2. */
const FILL_HEADINGS = () => [
  wHeading(1, run('Guide'), 'guide'),
  wHeading(2, run('Setup &amp; ') + '<w:r><w:rPr><w:rStyle w:val="VerbatimChar" /></w:rPr><w:t xml:space="preserve">TARIFF_PLAN</w:t></w:r>', 'setup'),
  wHeading(3, run('Detail'), 'detail'),
  wHeading(2, run('Quoted'), 'quoted', true),
  wHeading(1, run('A very long heading'), 'X0123456789abcdef0123456789abcdef0123456'),
];

interface Filled { ok: boolean; error?: string; xml?: string; entries?: [number, string, string][] }
function fillToc(xml: string, expected: number): Filled {
  const code = [
    'import importlib.util, json, sys',
    'import xml.etree.ElementTree as ET',
    'spec = importlib.util.spec_from_file_location("build_docs", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'req = json.loads(sys.stdin.read())',
    'try:',
    '    doc, entries = m.fill_toc(req["xml"], req["expected"])',
    'except m.BuildError as e:',
    '    print(json.dumps({"ok": False, "error": str(e)})); raise SystemExit(0)',
    'ET.fromstring(doc.encode("utf-8"))  # still well-formed XML',
    'print(json.dumps({"ok": True, "xml": doc, "entries": [[e.level, e.bookmark, e.text] for e in entries]}))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, BUILDER], { encoding: 'utf8', input: JSON.stringify({ xml, expected }), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, out(r));
  return JSON.parse(r.stdout) as Filled;
}

const sdtContent = (xml: string) => {
  const m = /<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/.exec(xml);
  assert.ok(m, 'no TOC block');
  return { inner: m![1], before: xml.slice(0, m!.index), after: xml.slice(m!.index + m![0].length) };
};

test('★★★ fill_toc: one entry per level-1 and level-2 heading, linked to its bookmark, level 2 indented, no page number', () => {
  const src = wDocument(FILL_HEADINGS());
  const f = fillToc(src, 4);
  assert.ok(f.ok, f.error);
  assert.deepEqual(f.entries, [
    [1, 'guide', 'Guide'],
    [2, 'setup', 'Setup &amp; TARIFF_PLAN'],
    [2, 'quoted', 'Quoted'],
    [1, 'X0123456789abcdef0123456789abcdef0123456', 'A very long heading'],
  ]);
  const toc = sdtContent(f.xml!);
  const paras = toc.inner.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
  assert.equal(paras.length, 1 + 4 + 1, 'the TOC heading, four entries and the closing paragraph');
  const entries = paras.slice(1, 5);
  for (const [i, [level, bookmark, text]] of f.entries!.entries()) {
    const p = entries[i];
    assert.ok(p.includes(`<w:hyperlink w:anchor="${bookmark}" w:history="1"><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:hyperlink>`), p);
    assert.equal(p.includes('<w:ind w:left="240" />'), level === 2, `level ${level} indent: ${p}`);
  }
  assert.ok(!/PAGEREF|<w:tab|w:leader/.test(toc.inner), 'a cached entry carries no page number, tab or leader');
  assert.ok(!toc.inner.includes('Detail'), 'a level-3 heading is not listed');
  // everything outside the TOC block is unchanged
  const was = sdtContent(src);
  assert.equal(toc.before, was.before);
  assert.equal(toc.after, was.after);
});

test('★★★ fill_toc: the field stays, as Word stores a TOC: begin (dirty), instruction and separator in the first entry\'s paragraph, the end in a closing paragraph', () => {
  const f = fillToc(wDocument(FILL_HEADINGS()), 4);
  assert.ok(f.ok, f.error);
  const paras = sdtContent(f.xml!).inner.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
  const first = paras[1];
  const marks = ['<w:fldChar w:fldCharType="begin" w:dirty="true" />', `<w:instrText xml:space="preserve">${TOC_INSTR}</w:instrText>`,
    '<w:fldChar w:fldCharType="separate" />', '<w:hyperlink w:anchor="guide"'];
  const at = marks.map((m) => first.indexOf(m));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `the first entry's paragraph: ${first}`);
  assert.equal(paras[paras.length - 1], '<w:p><w:r><w:fldChar w:fldCharType="end" /></w:r></w:p>');
  const chars = [...sdtContent(f.xml!).inner.matchAll(/<w:fldChar w:fldCharType="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(chars, ['begin', 'separate', 'end'], 'one field, no nested PAGEREF fields');
});

test('★★★ fill_toc: a level-1 or level-2 heading with no bookmark fails, naming it: an entry that links nowhere is not shipped', () => {
  const hs = FILL_HEADINGS();
  hs.splice(1, 0, wHeading(2, run('Orphan'), null));
  const f = fillToc(wDocument(hs), 5);
  assert.equal(f.ok, false);
  assert.match(f.error!, /^the \.docx heading "Orphan" \(level 2\) has no bookmark before it — its contents entry would link nowhere$/);
  // a level-3 heading without one is not listed, so it does not matter
  const deep = FILL_HEADINGS();
  deep.push(wHeading(3, run('Deep'), null));
  assert.ok(fillToc(wDocument(deep), 4).ok);
});

test('★★★ fill_toc: entries that do not number the assembled Markdown\'s level-1 and level-2 headings fail', () => {
  for (const expected of [3, 5]) {
    const f = fillToc(wDocument(FILL_HEADINGS()), expected);
    assert.equal(f.ok, false, `expected ${expected}`);
    assert.equal(f.error, `the .docx has 4 level-1 and level-2 headings, the assembled Markdown ${expected} — the contents would not match the document`);
  }
});

test('★★ fill_toc: no TOC field, two, or one of another depth fails', () => {
  assert.match(fillToc(wDocument(FILL_HEADINGS(), ''), 4).error ?? '', /holds 0 empty TOC fields as pandoc writes them, not 1/);
  assert.match(fillToc(wDocument(FILL_HEADINGS(), tocField() + tocField()), 4).error ?? '', /holds 2 empty TOC fields/);
  assert.match(fillToc(wDocument(FILL_HEADINGS(), tocField('TOC \\o &quot;1-3&quot; \\h \\z \\u')), 4).error ?? '', /lists levels 1-3, not 1-2/);
});

test('★★ toc_heading_count: the assembled fixture has 7 level-1 and 9 level-2 headings, the synthetic one included', () => {
  withFixture(undefined, (dir) => {
    const code = [
      'import importlib.util, sys',
      'from pathlib import Path',
      'spec = importlib.util.spec_from_file_location("build_docs", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m.toc_heading_count(m.Document(Path(sys.argv[2]), "main").assemble()))',
    ].join('\n');
    const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, BUILDER, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, out(r));
    assert.equal(r.stdout.trim(), '16');
  });
});

/* ── the real tools, where they are installed ─────────────────────────────── */

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const NO_PANDOC: string | false = has('pandoc') ? false : 'pandoc is not installed here (CI\'s docs job runs it on every PR)';
const LIBREOFFICE = ['libreoffice', 'soffice'].find(has) ?? null;
const NO_LIBREOFFICE: string | false = LIBREOFFICE ? false : 'LibreOffice is not installed here (CI\'s docs job runs it on every PR)';
const PDF_SCRIPT = join(ROOT, 'scripts', 'build-docs-pdf.py');

/** Why LibreOffice cannot run here, or null: installed is not enough (inside a command sandbox its
 *  first start can hang). One first start on a throwaway profile and TMPDIR, in a process group of
 *  its own that is killed after 30 s; run once, by the first test that needs it. */
let cannotStart: string | null | undefined;
function libreOfficeCannotStart(): string | null {
  if (cannotStart !== undefined) return cannotStart;
  const code = [
    'import os, shutil, signal, subprocess, sys, tempfile',
    'from pathlib import Path',
    'd = Path(tempfile.mkdtemp(prefix="lo-probe-"))',
    'try:',
    '    p = subprocess.Popen([sys.argv[1], "--headless", "--norestore", "-env:UserInstallation=" + (d / "profile").as_uri(), "--terminate_after_init"],',
    '                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,',
    '                         env=dict(os.environ, TMPDIR=str(d)))',
    '    try:',
    '        print(p.wait(timeout=float(sys.argv[2])))',
    '    except subprocess.TimeoutExpired:',
    '        print("timeout")',
    '    finally:',
    '        try:',
    '            os.killpg(p.pid, signal.SIGKILL)',
    '        except OSError:',
    '            pass',
    '        p.wait()',
    'finally:',
    '    shutil.rmtree(d, ignore_errors=True)',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, LIBREOFFICE!, '30'], { encoding: 'utf8', timeout: 60_000 });
  const got = r.stdout.trim();
  cannotStart = got === '0' ? null
    : `LibreOffice is installed but its first start here ${got === 'timeout' ? 'did not end within 30 s' : `exited ${got || r.status}`} `
      + '(a command sandbox can stop it); CI\'s docs job runs it on every PR';
  return cannotStart;
}
// a 1×1 PNG: pandoc reads the fixture's image, and --fail-if-warnings fails on one it cannot size
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FIXTURE_TOC = [
  [1, 'Readme title'], [1, 'Guide'], [2, 'Setup'], [1, 'Your home'], [2, 'Time zone'], [1, 'Options'], [2, 'Tariff'],
  [1, 'Entities'], [2, 'Sensors'], [1, 'Security'], [2, 'Reporting'], [1, 'Engineering reference'],
  [2, 'How this reference is organised'], [2, '1. One'], [2, '2. Two'], [2, 'Appendix A — Inventory'],
];

/** Build the fixture with pandoc; returns the build and the cached entries and bookmarks read back from the .docx. */
function buildFixtureDocx<T>(fn: (dir: string, docx: string, r: SpawnSyncReturns<string>) => T): T {
  return withFixture((f) => { f[P.shot] = PNG; }, (dir) => {
    const docx = join(dir, 'Power-Documentation.docx');
    return fn(dir, docx, build(['--repo-root', dir, '--output', docx]));
  });
}

test('★★★ pandoc: the fixture .docx caches its 16 level-1 and level-2 headings, in order, each linking the bookmark pandoc wrote for it', { skip: NO_PANDOC }, () => {
  buildFixtureDocx((_dir, docx, r) => {
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /^contents: 16 entries \(7 level-1, 9 level-2 headings\), no page numbers until the field is updated/m);
    const code = [
      'import json, re, sys, zipfile',
      'import xml.etree.ElementTree as ET',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None and z.namelist()[0] == "[Content_Types].xml"',
      'd = z.read("word/document.xml").decode("utf-8")',
      'ET.fromstring(d.encode("utf-8"))',
      'toc = re.search(r"<w:sdtContent>(.*?)</w:sdtContent>", d, re.S).group(1)',
      'entries = re.findall(r\'<w:hyperlink w:anchor="([^"]+)" w:history="1"><w:r><w:t xml:space="preserve">([^<]*)</w:t>\', toc)',
      'heads = {}',
      'for m in re.finditer(r\'<w:bookmarkStart w:id="\\d+" w:name="([^"]+)" />\\s*<w:p><w:pPr><w:pStyle w:val="Heading(\\d)" />(.*?)</w:p>\', d, re.S):',
      '    heads[m.group(1)] = [int(m.group(2)), "".join(re.findall(r"<w:t(?: [^>]*)?>([^<]*)</w:t>", m.group(3)))]',
      'print(json.dumps({"entries": entries, "heads": heads, "dirty": toc.count(\'w:fldCharType="begin" w:dirty="true"\'), "pageref": "PAGEREF" in toc}))',
    ].join('\n');
    const x = spawnSync(PYTHON, ['-I', '-B', '-c', code, docx], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(x.status, 0, out(x));
    const got = JSON.parse(x.stdout) as { entries: [string, string][]; heads: Record<string, [number, string]>; dirty: number; pageref: boolean };
    assert.deepEqual(got.entries.map(([, text]) => text), FIXTURE_TOC.map(([, t]) => t));
    for (const [i, [bookmark, text]] of got.entries.entries()) {
      assert.deepEqual(got.heads[bookmark], [FIXTURE_TOC[i][0], text], `entry "${text}" links ${bookmark}, which is not that heading's bookmark`);
    }
    assert.equal(got.dirty, 1, 'the field is still marked dirty: Word offers to rebuild it with page numbers');
    assert.equal(got.pageref, false);
  });
});

test('★★ pandoc: a contents that cannot be filled fails the build and leaves no .docx to be attached', { skip: NO_PANDOC }, () => {
  withFixture((f) => { f[P.shot] = PNG; }, (dir) => {
    const docx = join(dir, 'Power-Documentation.docx');
    const code = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("build_docs", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'm.toc_heading_count = lambda markdown: 999  # the Markdown and the .docx disagree',
      'raise SystemExit(m.main(["--repo-root", sys.argv[2], "--output", sys.argv[3]]))',
    ].join('\n');
    const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, BUILDER, dir, docx], { encoding: 'utf8' });
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /^build-docs-docx: the \.docx has 16 level-1 and level-2 headings, the assembled Markdown 999/m);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('Power-Documentation')), [], 'a .docx (or its staging file) was left');
  });
});

test('★★★ LibreOffice: build-docs-pdf.py renders the fixture build with its contents updated, 16 entries with rising page numbers, and leaves nothing behind', { skip: NO_PANDOC || NO_LIBREOFFICE }, (t) => {
  const why = libreOfficeCannotStart();
  if (why) { t.skip(why); return; }
  buildFixtureDocx((dir, docx, r) => {
    assert.equal(r.status, 0, out(r));
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    // the script's deadline under this call's bound: a LibreOffice that does not end fails with the script's own line
    const pdf = spawnSync(PYTHON, ['-I', '-B', PDF_SCRIPT, docx, '--deadline', '90'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: tmp } });
    assert.equal(pdf.status, 0, out(pdf));
    const m = /^wrote .*Power-Documentation\.pdf \([\d,]+ bytes\): the contents lists 16 entries, each with its page number \(pages (\d+) to (\d+)\)$/m.exec(pdf.stdout);
    assert.ok(m, out(pdf));
    assert.ok(Number(m![2]) > Number(m![1]), out(pdf));
    assert.equal(readFileSync(join(dir, 'Power-Documentation.pdf')).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(readdirSync(tmp), [], 'the profile or LibreOffice\'s temp outlived the run');
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.~lock')), [], 'a lock file was left beside the .docx');
  });
});

test('★★★ LibreOffice: a .docx it cannot load fails within seconds with one line, not a hang until the caller\'s timeout', { skip: NO_LIBREOFFICE }, (t) => {
  const why = libreOfficeCannotStart();
  if (why) { t.skip(why); return; }
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-load-'));
  try {
    // a contents the script's own checks accept (two cached entries, two headings), in a package
    // LibreOffice does not recognise, so its load gives nothing
    const docx = join(dir, 'Unloadable.docx');
    const code = [
      'import sys, zipfile',
      'start = (\'<w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /></w:r><w:r><w:instrText xml:space="preserve">TOC \\\\o &quot;1-2&quot; \\\\h \\\\z \\\\u</w:instrText></w:r>\'',
      '         \'<w:r><w:fldChar w:fldCharType="separate" /></w:r>\')',
      'entry = lambda a, first="": f\'<w:p>{first}<w:hyperlink w:anchor="{a}" w:history="1"><w:r><w:t>{a}</w:t></w:r></w:hyperlink></w:p>\'',
      'head = lambda level, a: f\'<w:bookmarkStart w:id="{level}" w:name="{a}" /><w:p><w:pPr><w:pStyle w:val="Heading{level}" /></w:pPr><w:r><w:t>{a}</w:t></w:r></w:p>\'',
      'xml = (\'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>\'',
      '       + entry("One", start) + entry("Two") + \'<w:p><w:r><w:fldChar w:fldCharType="end" /></w:r></w:p>\' + head(1, "One") + head(2, "Two") + "</w:body></w:document>")',
      'with zipfile.ZipFile(sys.argv[1], "w") as z:',
      '    z.writestr("[Content_Types].xml", "<Types/>")',
      '    z.writestr("word/document.xml", xml)',
    ].join('\n');
    const w = spawnSync(PYTHON, ['-I', '-B', '-c', code, docx], { encoding: 'utf8' });
    assert.equal(w.status, 0, out(w));
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    const t0 = Date.now();
    const r = spawnSync(PYTHON, ['-I', '-B', PDF_SCRIPT, docx, '--deadline', '60'], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: tmp } });
    const took = Date.now() - t0;
    assert.equal(r.status, 1, out(r));
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines[0], 'build-docs-pdf: the conversion macro failed: LibreOffice did not load the .docx', out(r));
    assert.deepEqual(lines.slice(1).filter((l) => !l.startsWith('libreoffice: ')), [], out(r));
    assert.ok(took < 45_000, `it took ${took} ms`);
    assert.deepEqual(readdirSync(tmp), [], 'the profile or LibreOffice\'s temp outlived the run');
    assert.deepEqual(readdirSync(dir).sort(), ['Unloadable.docx', 'tmp'], 'a lock file or a PDF was left beside the .docx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
