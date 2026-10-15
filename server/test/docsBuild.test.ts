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

type Files = Record<string, string | null>;
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
  const scan = checkAssembled(md, [P.readme, P.guide, P.options, P.entities, P.security, P.ref1, P.ref21, P.ref22, P.refA]);
  const order = ['# Readme title', '# Guide', '# Options', '# Entities', '# Security', '# Engineering reference', '## 1. One', '## 2. Two', '### Bridge section', '## Appendix A'];
  const at = order.map((h) => (md.startsWith(h) ? 0 : md.indexOf(`\n${h}`)));
  for (let i = 0; i < at.length; i++) assert.ok(at[i] >= 0 && (i === 0 || at[i] > at[i - 1]), `${order[i]} is missing or out of order`);
  const h1 = scan.headings.filter((h) => h.level === 1).map((h) => h.raw.replace(ID_SUFFIX, ''));
  assert.deepEqual(h1, ['Readme title', 'Guide', 'Options', 'Entities', 'Security', 'Engineering reference']);
  // a page break before each of: guide, options, entities, security, the reference, chapters 1, 2, A
  assert.equal(md.split(BREAK).length - 1, 8);
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

test('the repository: the printed sources are README, the guide pages, SECURITY, the index preamble and all 19 reference files in manifest order', () => {
  const r = build(['--list-sources']);
  assert.equal(r.status, 0, out(r));
  const rows = r.stdout.trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows.slice(0, 6), [
    ['readme', P.readme], ['guide', P.guide], ['guide', P.options], ['guide', P.entities], ['security', P.security], ['preamble', P.index],
  ]);
  const refs = rows.slice(6).map(([, rel]) => rel);
  const onDisk = readdirSync(REFERENCE_DIR).filter((n) => n.endsWith(MD) && n !== 'README' + MD).sort().map((n) => `${D}/reference/${n}`);
  assert.equal(refs.length, 19);
  assert.deepEqual(refs, onDisk, 'the manifest is in file-name order and names every reference file');
  for (const [role, rel] of rows.slice(6)) {
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
