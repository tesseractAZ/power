/**
 * 1.209.1 — scripts/build-docs-pdf.py renders the printable .docx to the .pdf both workflows ship,
 * with the table of contents updated before the export. A plain `libreoffice --convert-to pdf`
 * does not update indexes: every release PDF up to 1.209.0 printed "Table of Contents" over
 * nothing, and the conversion exited 0. The script fails instead, on a mechanism, not a promise:
 * the macro that converts reports the contents' text after the update, and the entries that end
 * in a page number must number the entries build-docs-docx.py cached in the .docx's TOC field
 * (read before LibreOffice starts, never from LibreOffice, never 0, one per Heading1 and Heading2
 * paragraph), with pages that rise.
 *
 * Every case here runs the script against a STUB LibreOffice on PATH (a Python script written to a
 * mkdtemp directory, removed in `finally`), so no LibreOffice is needed. The stub behaves as
 * LibreOffice does where it matters:
 *   - its first start with a new profile creates the profile and REWRITES
 *     user/basic/Standard/script.xlb, listing only Module1 (the first-start trap: a module written
 *     before that start is not registered);
 *   - a macro URL naming a module that is not registered does nothing, and exits 0;
 *   - a registered DocsPdf.Convert writes a lock file beside the document it loads (removed when
 *     it ends normally, left when it is stopped) and an entry in its TMPDIR (left), then the PDF and
 *     the report the real macro writes, shaped by STUB_MODE (missing or empty PDF, no report,
 *     entries without page numbers or with pages out of order, a Basic error, a hang until SIGTERM,
 *     a hang that ignores SIGTERM).
 * docsBuild.test.ts runs the real LibreOffice on a real pandoc build and on a .docx it cannot
 * load, where LibreOffice is installed and starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'build-docs-pdf.py');

const PYTHON = (() => {
  const r = spawnSync('python3', ['-I', '-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python3 is required: ${r.stderr}`);
  return r.stdout.trim();
})();

/* ── a .docx, as far as the script reads one: word/document.xml ──────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
interface FieldShape { depth?: number; cached?: number; pageref?: boolean }
/** The contents field as build-docs-docx.py leaves it: begin (dirty), instruction and separator in
 *  the first entry's paragraph, one hyperlink per cached entry, the end in a closing paragraph.
 *  `cached: 0` is pandoc's own empty field, as every .docx up to 1.209.0 held it; `pageref` gives
 *  each entry a nested PAGEREF field, as Word stores an updated contents. */
function tocField(o: FieldShape = {}): string {
  const instr = `<w:instrText xml:space="preserve">TOC \\o &quot;1-${o.depth ?? 2}&quot; \\h \\z \\u</w:instrText>`;
  const n = o.cached ?? 3;
  if (n === 0) {
    return `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true" />${instr}`
      + '<w:fldChar w:fldCharType="separate" /><w:fldChar w:fldCharType="end" /></w:r></w:p>';
  }
  const start = `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /></w:r><w:r>${instr}</w:r><w:r><w:fldChar w:fldCharType="separate" /></w:r>`;
  const pageref = (i: number) => (o.pageref
    ? '<w:r><w:tab /></w:r><w:r><w:fldChar w:fldCharType="begin" /></w:r>'
      + `<w:r><w:instrText xml:space="preserve"> PAGEREF h${i} \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate" /></w:r>`
      + `<w:r><w:t>${i + 3}</w:t></w:r><w:r><w:fldChar w:fldCharType="end" /></w:r>`
    : '');
  const entries = Array.from({ length: n }, (_, i) => `<w:p>${i === 0 ? start : ''}<w:hyperlink w:anchor="h${i}" w:history="1">`
    + `<w:r><w:t xml:space="preserve">Entry ${i}</w:t></w:r>${pageref(i)}</w:hyperlink></w:p>`);
  return `${entries.join('')}<w:p><w:r><w:fldChar w:fldCharType="end" /></w:r></w:p>`;
}
const heading = (level: number, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${level}" /></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
/** One level-1, two level-2 and one level-3 heading: a 1-2 contents lists 3. */
const HEADINGS: [number, string][] = [[1, 'One'], [2, 'One A'], [3, 'One A i'], [2, 'One B']];
function documentXml(o: FieldShape & { fields?: number; headings?: [number, string][] } = {}): string {
  const fields = Array.from({ length: o.fields ?? 1 }, () => tocField(o)).join('');
  // a link in the body to a heading's bookmark: after the field's end, so not one of its entries
  const body = '<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink w:anchor="h0"><w:r><w:t>One</w:t></w:r></w:hyperlink></w:p>';
  return `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${fields}`
    + (o.headings ?? HEADINGS).map(([l, t]) => heading(l, t)).join('') + `${body}</w:body></w:document>`;
}

function writeDocx(path: string, xml: string): void {
  const code = 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n'
    + '    z.writestr("[Content_Types].xml", "<Types/>")\n    z.writestr("word/document.xml", sys.stdin.read())\n';
  const r = spawnSync(PYTHON, ['-I', '-B', '-c', code, path], { input: xml, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/* ── the stub LibreOffice ─────────────────────────────────────────────────── */

const STUB = `#!${PYTHON} -IB
import json, os, pathlib, re, signal, sys, time
from urllib.parse import unquote, urlsplit
args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"cmd": os.path.basename(sys.argv[0]), "args": args, "tmpdir": os.environ.get("TMPDIR", "")}) + "\\n")
def path(url):
    return pathlib.Path(unquote(urlsplit(url).path))
mode = os.environ.get("STUB_MODE", "ok")
prof = [a for a in args if a.startswith("-env:UserInstallation=")]
if len(prof) != 1:
    sys.exit(81)
profile = path(prof[0].split("=", 1)[1])
std = profile / "user" / "basic" / "Standard"
# the first start with a new profile: the profile is created and Standard/script.xlb rewritten
if mode != "noinit" and not (profile / "user" / "registrymodifications.xcu").exists():
    std.mkdir(parents=True, exist_ok=True)
    xlb_text = '<?xml version="1.0" encoding="UTF-8"?>\\n<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard">\\n <library:element library:name="Module1"/>\\n</library:library>\\n'
    (std / "script.xlb").write_text(xlb_text if mode != "badxlb" else xlb_text.replace("</library:library>", ""), encoding="utf-8")
    (profile / "user" / "registrymodifications.xcu").write_text("<items/>\\n", encoding="utf-8")
if "--terminate_after_init" in args:
    sys.exit(0)
calls = [a for a in args if a.startswith("macro:///")]
m = re.fullmatch(r'macro:///Standard\\.DocsPdf\\.Convert\\("([^"]*)","([^"]*)","([^"]*)"\\)', calls[0]) if len(calls) == 1 else None
xlb = std / "script.xlb"
if not (m and xlb.is_file() and 'library:name="DocsPdf"' in xlb.read_text(encoding="utf-8") and (std / "DocsPdf.xba").is_file()):
    sys.exit(0)  # an unregistered macro: nothing happens, and the exit is 0
docx, pdf, report = path(m.group(1)), path(m.group(2)), path(m.group(3))
# as LibreOffice: a lock file beside the document it opens, and an entry in its TMPDIR
lock = docx.parent / (".~lock." + docx.name + "#")
lock.write_text("stub\\n")
(pathlib.Path(os.environ["TMPDIR"]) / ("lu" + str(os.getpid()) + ".tmp")).write_text("stub\\n")
if mode in ("hang", "wedged"):
    def termed(signum, frame):
        pathlib.Path(os.environ["STUB_TERMED"]).write_text("SIGTERM\\n")
        if mode == "hang":
            sys.exit(0)
    signal.signal(signal.SIGTERM, termed)  # "wedged" goes on running
    started = pathlib.Path(os.environ["STUB_STARTED"])
    started.with_suffix(".tmp").write_text(str(os.getpid()))
    os.replace(started.with_suffix(".tmp"), started)
    end = time.monotonic() + 30
    while time.monotonic() < end:
        time.sleep(0.05)
    sys.exit(0)
if mode == "error":
    report.write_text("error Basic error 91 at line 9: Object variable not set.\\n", encoding="utf-8")
    lock.unlink()
    sys.exit(0)
if mode != "nopdf":
    pdf.write_bytes({"emptypdf": b"", "notpdf": b"<html>not a pdf</html>"}.get(mode, b"%PDF-1.7\\n%stub\\n"))
page = {"nonumbers": lambda i: "", "zeros": lambda i: "\\t0", "samepage": lambda i: "\\t7",
        "backwards": lambda i: "\\t" + str(9 - i)}.get(mode, lambda i: "\\t" + str(i + 3))
n = int(os.environ.get("STUB_ENTRIES", "0"))
lines = ["indexes 1", "contents", "Table of Contents"] + ["Entry " + str(i) + page(i) for i in range(n)] + ["end"]
if mode == "noreport":
    print("stub: the macro wrote no report")
else:
    report.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
lock.unlink()
`;

interface Call { cmd: string; args: string[]; tmpdir: string }
interface Run {
  r: SpawnSyncReturns<string>;
  calls: Call[];
  /** what the script left in its TMPDIR */
  tmpLeft: string[];
  /** what is beside the .docx afterwards */
  beside: string[];
  pdf: Buffer | null;
  out: string;
}

interface Setup { dir: string; bin: string; tmp: string; docx: string; pdf: string; env: NodeJS.ProcessEnv }
interface Options { xml?: string; mode?: string; entries?: number; commands?: string[]; stale?: boolean; args?: string[] }

function setup(dir: string, o: Options): Setup {
  const bin = join(dir, 'bin');
  const tmp = join(dir, 'tmp');
  const doc = join(dir, 'doc');
  for (const d of [bin, tmp, doc]) mkdirSync(d);
  for (const c of o.commands ?? ['soffice']) {
    writeFileSync(join(bin, c), STUB);
    chmodSync(join(bin, c), 0o755);
  }
  const docx = join(doc, 'Power-Documentation.docx');
  writeDocx(docx, o.xml ?? documentXml());
  return {
    dir, bin, tmp, docx, pdf: join(doc, 'Power-Documentation.pdf'),
    env: {
      PATH: bin, HOME: dir, TMPDIR: tmp, LANG: 'C.UTF-8',
      STUB_LOG: join(dir, 'stub.log'), STUB_MODE: o.mode ?? 'ok', STUB_ENTRIES: String(o.entries ?? 3),
      STUB_STARTED: join(dir, 'stub.started'), STUB_TERMED: join(dir, 'stub.termed'),
    },
  };
}

const calls = (s: Setup): Call[] => (existsSync(s.env.STUB_LOG!) ? readFileSync(s.env.STUB_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : []);
const describe = (s: Setup, r: { status: number | null; stdout: string; stderr: string }) =>
  `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}\ncalls: ${existsSync(s.env.STUB_LOG!) ? readFileSync(s.env.STUB_LOG!, 'utf8') : '(none)'}`;

/** Run the script once against the stub; everything is removed afterwards. */
function render(o: Options = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-test-'));
  try {
    const s = setup(dir, o);
    if (o.stale) writeFileSync(s.pdf, '%PDF-1.7 from an earlier run');
    const r = spawnSync(PYTHON, ['-I', '-B', SCRIPT, s.docx, ...(o.args ?? [])], { env: s.env, encoding: 'utf8', timeout: 60_000 });
    return {
      r, calls: calls(s), tmpLeft: readdirSync(s.tmp), beside: readdirSync(join(dir, 'doc')).sort(),
      pdf: existsSync(s.pdf) ? readFileSync(s.pdf) : null,
      out: describe(s, r),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One line naming why, first on stderr; any other line is LibreOffice's output, so prefixed. */
function assertOneLine(stderr: string, why: RegExp, out: string): void {
  const lines = stderr.trim().split('\n');
  assert.match(lines[0], /^build-docs-pdf: /, `the reason comes first: ${out}`);
  assert.match(lines[0], why, out);
  assert.equal(lines.filter((l) => l.startsWith('build-docs-pdf: ')).length, 1, `one error line: ${out}`);
  assert.deepEqual(lines.slice(1).filter((l) => !l.startsWith('libreoffice: ')), [], `a line that is neither: ${out}`);
  assert.ok(!stderr.includes('Traceback'), out);
}

/** The script failed with exit 1 and one line naming `why`, left no PDF and cleaned its temp. */
function assertFailed(run: Run, why: RegExp): void {
  assert.equal(run.r.status, 1, run.out);
  assertOneLine(run.r.stderr, why, run.out);
  assert.equal(run.r.stdout, '', run.out);
  assert.equal(run.pdf, null, 'a failed render left a PDF at the output path');
  assert.deepEqual(run.tmpLeft, [], 'the profile, the report or LibreOffice\'s temp outlived a failed run');
  assert.deepEqual(run.beside, ['Power-Documentation.docx'], 'something was left beside the .docx');
}

const profileOf = (c: Call) => c.args.find((a) => a.startsWith('-env:UserInstallation='))?.split('=')[1] ?? '';

/* ── the render ───────────────────────────────────────────────────────────── */

test('★★★ renders and checks: one LibreOffice start to make the profile, then the registered macro on a copy of the .docx; the contents lists one paged entry per cached entry', () => {
  const run = render();
  assert.equal(run.r.status, 0, run.out);
  assert.match(run.r.stdout, /^wrote .*Power-Documentation\.pdf \(\d+ bytes\): the contents lists 3 entries, each with its page number \(pages 3 to 5\)\n$/);
  assert.equal(run.r.stderr, '', run.out);
  assert.equal(run.pdf?.toString(), '%PDF-1.7\n%stub\n');
  assert.equal(run.calls.length, 2, run.out);
  const [init, convert] = run.calls;
  // the first start initialises the profile, and only then is the module written and registered
  assert.ok(init.args.includes('--terminate_after_init') && init.args.includes('--headless'), run.out);
  assert.ok(convert.args.includes('--headless'), run.out);
  assert.equal(profileOf(init), profileOf(convert), 'the macro runs on the profile the first start made');
  const macro = convert.args.find((a) => a.startsWith('macro:///'))!;
  const urls = /^macro:\/\/\/Standard\.DocsPdf\.Convert\("([^"]+)","([^"]+)","([^"]+)"\)$/.exec(macro);
  assert.ok(urls, macro);
  // the profile, the copy of the .docx, the PDF before its check and the report are all in one temporary directory
  const tmpRoot = profileOf(init).replace(/\/profile$/, '');
  assert.ok(tmpRoot.startsWith('file://') && tmpRoot !== profileOf(init), profileOf(init));
  assert.equal(urls![1], `${tmpRoot}/docx/Power-Documentation.docx`, 'the macro loads a copy in the work directory, never the caller\'s .docx');
  for (const u of [urls![2], urls![3]]) assert.ok(u.startsWith(`${tmpRoot}/`), `${u} is not beside the profile`);
  // LibreOffice's temporary files go to the work directory too
  const workPath = decodeURIComponent(new URL(tmpRoot).pathname);
  for (const c of run.calls) assert.equal(c.tmpdir, `${workPath}/tmp`, `LibreOffice's TMPDIR: ${run.out}`);
  assert.deepEqual(run.tmpLeft, [], 'the profile, the report or LibreOffice\'s temp outlived a good run');
  assert.deepEqual(run.beside, ['Power-Documentation.docx', 'Power-Documentation.pdf']);
});

test('★★★ the count: paged entries fewer or more than the entries cached in the .docx fail', () => {
  assertFailed(render({ entries: 2 }), /^build-docs-pdf: the PDF's contents lists 2 entries with a page number; the document has 3 headings its contents must list$/);
  assertFailed(render({ entries: 4 }), /lists 4 entries with a page number; the document has 3 headings/);
  assertFailed(render({ entries: 0 }), /lists 0 entries with a page number; the document has 3 headings/);
});

test('★★★ the number to check against comes from the .docx before LibreOffice starts, never from LibreOffice, and is never 0', () => {
  const before = (o: Options, why: RegExp) => {
    const run = render(o);
    assertFailed(run, why);
    assert.deepEqual(run.calls, [], `LibreOffice was started: ${run.out}`);
  };
  // pandoc's own empty field (every .docx up to 1.209.0): nothing cached, nothing to count against
  before({ xml: documentXml({ cached: 0 }), entries: 0 },
    /Power-Documentation\.docx: the table-of-contents field caches no entries \(build-docs-docx\.py writes one per level-1 and level-2 heading\)/);
  // … also in a document with no headings at all, where an empty contents would count as complete
  before({ xml: documentXml({ cached: 0, headings: [] }), entries: 0 }, /caches no entries/);
  // cached entries unlike the document's Heading1 and Heading2 paragraphs: restyled, or one more
  before({ xml: documentXml({ headings: [] }) }, /: the table-of-contents field caches 3 entries and the document has 0 level-1 and level-2 headings — not a \.docx as build-docs-docx\.py writes it$/);
  before({ xml: documentXml({ headings: [...HEADINGS, [2, 'One C']] }) }, /caches 3 entries and the document has 4 level-1 and level-2 headings/);
  before({ xml: documentXml({ headings: [[1, 'One'], [2, 'One A']] }) }, /caches 3 entries and the document has 2 level-1 and level-2 headings/);
  // a level-3 heading is not one the contents lists
  assert.equal(render({ xml: documentXml({ headings: [...HEADINGS, [3, 'One B i']] }) }).r.status, 0);
});

test('★★ a field of another depth than 1-2 fails before LibreOffice starts', () => {
  for (const depth of [1, 3]) {
    const run = render({ xml: documentXml({ depth }) });
    assertFailed(run, new RegExp(`: the table-of-contents field lists levels 1-${depth}, not 1-2$`));
    assert.deepEqual(run.calls, [], 'LibreOffice was started');
  }
});

test('★★ the entries counted are the field\'s own: a nested PAGEREF (as Word stores an updated contents) is passed over, a link in the body after the field is not counted', () => {
  // documentXml always has a body link after the field: the passes above count 3, not 4
  const run = render({ xml: documentXml({ pageref: true }) });
  assert.equal(run.r.status, 0, run.out);
  assert.match(run.r.stdout, /the contents lists 3 entries/);
  // a field with no end is not counted to the end of the document
  const open = documentXml().replace('<w:p><w:r><w:fldChar w:fldCharType="end" /></w:r></w:p>', '');
  assertFailed(render({ xml: open }), /the table-of-contents field has no separator or no end$/);
});

test('★★★ a contents whose entries carry no page number fails: the cached entries printed as they are are the defect', () => {
  assertFailed(render({ mode: 'nonumbers' }), /lists 0 entries with a page number; the document has 3 headings/);
  // a cached "0" (a PAGEREF never evaluated) is not a page number either
  assertFailed(render({ mode: 'zeros' }), /lists 0 entries with a page number; the document has 3 headings/);
});

test('★★ a contents whose pages go back, or end on the page they start, was not laid out, and fails', () => {
  assertFailed(render({ mode: 'backwards' }), /^build-docs-pdf: the PDF's contents goes back from page 9 to page 8 at entry 2 — its pages were not laid out$/);
  assertFailed(render({ mode: 'samepage' }), /^build-docs-pdf: the PDF's contents names page 7 for its first entry and page 7 for its last — its pages were not laid out$/);
});

test('★★★ a macro that did not run is a failure, not an exit 0 with no contents; the reason comes first, LibreOffice\'s output after it', () => {
  const none = render({ mode: 'noreport' });
  assertFailed(none, /^build-docs-pdf: the conversion macro did not run \(LibreOffice exited 0 and wrote no report\)$/);
  assert.deepEqual(none.r.stderr.trim().split('\n').slice(1), ['libreoffice: stub: the macro wrote no report'], none.out);
  // a LibreOffice whose first start makes no profile: the module cannot be registered
  assertFailed(render({ mode: 'noinit' }), /LibreOffice did not initialise its profile \(its first start exited 0; .*script\.xlb is missing\)/);
  // a library file the module cannot be listed in
  assertFailed(render({ mode: 'badxlb' }), /script\.xlb: no <\/library:library> to register the conversion macro before$/);
});

test('★★ no PDF, an empty PDF or a file that is not a PDF fails; so does a Basic error in the macro, quoted', () => {
  assertFailed(render({ mode: 'nopdf' }), /LibreOffice wrote no PDF, or an empty one/);
  assertFailed(render({ mode: 'emptypdf' }), /LibreOffice wrote no PDF, or an empty one/);
  assertFailed(render({ mode: 'notpdf' }), /LibreOffice wrote a file that is not a PDF/);
  assertFailed(render({ mode: 'error' }), /^build-docs-pdf: the conversion macro failed: Basic error 91 at line 9: Object variable not set\.$/);
});

test('★★ a PDF from an earlier run is removed first, whatever the exit, so a failed run never leaves one to be uploaded', () => {
  assertFailed(render({ mode: 'nonumbers', stale: true }), /lists 0 entries/);
  // the usage exits too
  const none = render({ commands: [], stale: true });
  assert.equal(none.r.status, 2, none.out);
  assert.equal(none.pdf, null, 'the PDF of an earlier run outlived an exit 2');
  // and a good run replaces it with the checked one
  const ok = render({ stale: true });
  assert.equal(ok.r.status, 0, ok.out);
  assert.equal(ok.pdf?.toString(), '%PDF-1.7\n%stub\n');
});

test('★★ a .docx with no table-of-contents field, or two, fails before LibreOffice starts', () => {
  for (const fields of [0, 2]) {
    const run = render({ xml: documentXml({ fields }) });
    assertFailed(run, new RegExp(`${fields} table-of-contents fields, not 1`));
    assert.deepEqual(run.calls, [], 'LibreOffice was started');
  }
});

test('★ a .docx that is missing is exit 2 (its stale PDF removed); one that is not a .docx is one line and exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-test-'));
  try {
    const s = setup(dir, {});
    writeFileSync(join(dir, 'doc', 'gone.pdf'), '%PDF-1.7 from an earlier run');
    const gone = spawnSync(PYTHON, ['-I', '-B', SCRIPT, join(dir, 'doc', 'gone.docx')], { env: s.env, encoding: 'utf8' });
    assert.equal(gone.status, 2, gone.stderr);
    assert.match(gone.stderr, /^build-docs-pdf: .*gone\.docx: no such file\n$/);
    assert.ok(!existsSync(join(dir, 'doc', 'gone.pdf')), 'the PDF of an earlier run outlived the exit 2');
    writeFileSync(s.docx, 'not a zip');
    const bad = spawnSync(PYTHON, ['-I', '-B', SCRIPT, s.docx], { env: s.env, encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /^build-docs-pdf: .*Power-Documentation\.docx: not a readable \.docx \(File is not a zip file\)\n$/);
    assert.ok(!existsSync(s.env.STUB_LOG!), 'LibreOffice was started for a file that is not a .docx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ finds `libreoffice` (Ubuntu) or `soffice` (macOS), preferring libreoffice; neither on PATH is exit 2', () => {
  for (const [commands, used] of [[['libreoffice'], 'libreoffice'], [['soffice'], 'soffice'], [['libreoffice', 'soffice'], 'libreoffice']] as const) {
    const run = render({ commands: [...commands] });
    assert.equal(run.r.status, 0, run.out);
    assert.deepEqual(run.calls.map((c) => c.cmd), [used, used], `${commands.join('+')}: ${run.out}`);
  }
  const none = render({ commands: [] });
  assert.equal(none.r.status, 2, none.out);
  assert.match(none.r.stderr, /^build-docs-pdf: neither libreoffice nor soffice is on PATH \(CI installs libreoffice-writer\)\n$/);
  assert.deepEqual(none.tmpLeft, []);
});

test('★★ --output names the PDF (default: beside the .docx); a directory that is missing is exit 2 before LibreOffice starts, a PDF path that is the .docx is exit 2 and keeps it, one that cannot be written is one line and exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-test-'));
  const ro = join(dir, 'ro');
  try {
    const s = setup(dir, {});
    const run = (...args: string[]) => spawnSync(PYTHON, ['-I', '-B', SCRIPT, ...args], { env: s.env, encoding: 'utf8' });
    const out = join(dir, 'elsewhere.pdf');
    const r = run(s.docx, '--output', out);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(out) && !existsSync(s.pdf), 'the PDF is written where --output says');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('partial')), [], 'no staging file left');
    rmSync(s.env.STUB_LOG!);

    const nodir = run(s.docx, '--output', join(dir, 'nodir', 'x.pdf'));
    assert.equal(nodir.status, 2, nodir.stderr);
    assert.match(nodir.stderr, /^build-docs-pdf: .*\/nodir: no such directory for the PDF\n$/);
    assert.ok(!existsSync(s.env.STUB_LOG!), 'LibreOffice was started for a PDF that has nowhere to go');

    const same = join(dir, 'doc', 'Same.pdf');
    writeDocx(same, documentXml());
    const sameRun = run(same);
    assert.equal(sameRun.status, 2, sameRun.stderr);
    assert.match(sameRun.stderr, /^build-docs-pdf: .*Same\.pdf: the PDF would replace the \.docx\n$/);
    assert.ok(existsSync(same), 'the .docx was removed as a stale PDF');

    if (process.getuid?.() !== 0) {
      mkdirSync(ro);
      chmodSync(ro, 0o555);
      const denied = run(s.docx, '--output', join(ro, 'x.pdf'));
      assert.equal(denied.status, 1, denied.stderr);
      assertOneLine(denied.stderr, /^build-docs-pdf: .*Permission denied/, denied.stderr);
    }
  } finally {
    if (existsSync(ro)) chmodSync(ro, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── a LibreOffice that does not end ──────────────────────────────────────── */

test('★★★ --deadline: LibreOffice still converting when it runs out is stopped (SIGTERM first) and the run fails with one line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-test-'));
  let stub = 0;
  try {
    const s = setup(dir, { mode: 'hang' });
    const t0 = Date.now();
    const r = spawnSync(PYTHON, ['-I', '-B', SCRIPT, s.docx, '--deadline', '5'], { env: s.env, encoding: 'utf8', timeout: 30_000 });
    const out = describe(s, r);
    stub = existsSync(s.env.STUB_STARTED!) ? Number(readFileSync(s.env.STUB_STARTED!, 'utf8')) : 0;
    assert.equal(r.status, 1, out);
    assertOneLine(r.stderr, /^build-docs-pdf: LibreOffice was still converting the \.docx when its 5 s \(--deadline\) ran out; it was stopped$/, out);
    assert.ok(Date.now() - t0 < 20_000, `it ended ${Date.now() - t0} ms after it started`);
    assert.ok(existsSync(s.env.STUB_TERMED!), 'LibreOffice was not sent SIGTERM before SIGKILL');
    assert.ok(stub > 0);
    assert.throws(() => process.kill(stub, 0), 'LibreOffice outlived the run');
    assert.deepEqual(readdirSync(s.tmp), []);
    assert.deepEqual(readdirSync(join(dir, 'doc')), ['Power-Documentation.docx'], 'a lock file or a PDF was left beside the .docx');
  } finally {
    if (stub) { try { process.kill(stub, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
async function waitFor(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, what);
    await sleep(50);
  }
}

/** Start the script on a stub that hangs, stop it with `signals` (each once the one before has
 *  reached the stub, where it does), and return how it ended and what it left. */
async function stopped(mode: 'hang' | 'wedged', signals: NodeJS.Signals[]) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-pdf-test-'));
  let stub = 0;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const s = setup(dir, { mode });
    child = spawn(PYTHON, ['-I', '-B', SCRIPT, s.docx], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += String(d); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((res) => { child!.on('exit', (code, signal) => res({ code, signal })); });
    await waitFor(s.env.STUB_STARTED!, 'the stub LibreOffice never started');
    stub = Number(readFileSync(s.env.STUB_STARTED!, 'utf8'));
    assert.ok(stub > 0);
    child.kill(signals[0]);
    for (const sig of signals.slice(1)) {
      await waitFor(s.env.STUB_TERMED!, 'the stop never reached LibreOffice');
      child.kill(sig);
    }
    let timer: NodeJS.Timeout | undefined;
    const end = await Promise.race([exited, new Promise<null>((r) => { timer = setTimeout(() => r(null), 15_000); })]);
    clearTimeout(timer);
    await sleep(50);
    let alive = true;
    try { process.kill(stub, 0); } catch { alive = false; }
    return {
      end, stderr, alive, termed: existsSync(s.env.STUB_TERMED!),
      tmpLeft: readdirSync(s.tmp), beside: readdirSync(join(dir, 'doc')),
    };
  } finally {
    if (stub) { try { process.kill(stub, 'SIGKILL'); } catch { /* gone */ } }
    child?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★★ stopped by the caller\'s `timeout` (SIGTERM): one line, then LibreOffice is stopped (SIGTERM first) and nothing it wrote outlives the run, nor a lock beside the .docx', async () => {
  const run = await stopped('hang', ['SIGTERM']);
  assert.ok(run.end, 'the script did not exit within 15 s of SIGTERM (it waited for LibreOffice)');
  assert.deepEqual(run.end, { code: 143, signal: null }, 'SIGTERM unwinds through the finally blocks and exits 128 + 15');
  assertOneLine(run.stderr, /^build-docs-pdf: stopped by SIGTERM after \d+ s, while LibreOffice was converting the \.docx$/, run.stderr);
  assert.ok(run.termed, 'LibreOffice was not sent SIGTERM before SIGKILL');
  assert.equal(run.alive, false, 'LibreOffice outlived the run');
  assert.deepEqual(run.tmpLeft, [], 'the profile or LibreOffice\'s temp outlived the run');
  assert.deepEqual(run.beside, ['Power-Documentation.docx'], 'a lock file (which makes the next run on the file wait) or a PDF was left beside the .docx');
});

test('★★ stopped by SIGINT (Ctrl-C): the same, exit 130, with no traceback', async () => {
  const run = await stopped('hang', ['SIGINT']);
  assert.deepEqual(run.end, { code: 130, signal: null }, run.stderr);
  assertOneLine(run.stderr, /^build-docs-pdf: stopped by SIGINT after \d+ s, while LibreOffice was converting the \.docx$/, run.stderr);
  assert.equal(run.alive, false, 'LibreOffice outlived the run');
  assert.deepEqual(run.tmpLeft, []);
  assert.deepEqual(run.beside, ['Power-Documentation.docx']);
});

test('★★ a LibreOffice that ignores SIGTERM is killed after the grace, and a second SIGTERM during it does not cut the cleanup short', async () => {
  const run = await stopped('wedged', ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(run.end, { code: 143, signal: null }, run.stderr);
  assertOneLine(run.stderr, /^build-docs-pdf: stopped by SIGTERM after \d+ s, while LibreOffice was converting the \.docx$/, run.stderr);
  assert.equal(run.alive, false, 'a LibreOffice that ignores SIGTERM outlived the run');
  assert.deepEqual(run.tmpLeft, []);
  assert.deepEqual(run.beside, ['Power-Documentation.docx']);
});

/* ── the script's constants against the workflows and the builder ─────────── */

const SRC = readFileSync(SCRIPT, 'utf8');
const constant = (src: string, name: string) => {
  const m = new RegExp(`^${name} = (\\d+)$`, 'm').exec(src);
  assert.ok(m, `no ${name}`);
  return Number(m![1]);
};

test('★★ the script\'s own deadline ends LibreOffice, with a line, before the workflows\' `timeout` ends the step with none', () => {
  const deadline = constant(SRC, 'DEADLINE_SECONDS');
  const grace = constant(SRC, 'GRACE_SECONDS');
  const bounds: number[] = [];
  for (const file of ['ci.yml', 'images.yml']) {
    const yml = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8');
    const found = [...yml.matchAll(/^ +timeout -k \d+ (\d+) python3 -I -B scripts\/build-docs-pdf\.py /gm)].map((m) => Number(m[1]));
    assert.equal(found.length, 1, `${file}: the PDF step`);
    bounds.push(...found);
  }
  // after the deadline: SIGTERM, the grace, SIGKILL, then up to a grace more for LibreOffice's last output; 20 s for the rest
  for (const b of bounds) assert.ok(deadline + 2 * grace + 20 <= b, `deadline ${deadline} s + 2 × ${grace} s + 20 s vs the step's timeout ${b} s`);
});

test('★ the contents depth the PDF is checked at is the one the builder fills', () => {
  const builder = readFileSync(join(ROOT, 'scripts', 'build-docs-docx.py'), 'utf8');
  assert.equal(constant(SRC, 'TOC_DEPTH'), constant(builder, 'TOC_DEPTH'));
  assert.equal(constant(SRC, 'TOC_DEPTH'), 2);
});

/* ── the module the script registers ──────────────────────────────────────── */

test('★★ the Basic module updates every index twice before the export, reports each contents after it, and every way out writes the report and ends LibreOffice', () => {
  // The real LibreOffice runs it in docsBuild.test.ts; this pins its shape where LibreOffice is absent.
  const macro = /^MACRO = """([\s\S]*?)"""$/m.exec(SRC)?.[1] ?? '';
  const convert = /Sub Convert\([\s\S]*?\nEnd Sub\n/.exec(macro)?.[0] ?? '';
  const at = (s: string) => { const i = convert.indexOf(s); assert.ok(i >= 0, `the module lacks ${s}`); return i; };
  assert.ok(at('On Error GoTo Failed') < at('loadComponentFromURL'), 'a Basic error is reported, not left to a dialog');
  // a .docx that does not load: loadComponentFromURL gives Null, and the report says so
  assert.ok(at('loadComponentFromURL') < at('If IsNull(doc) Then') && at('If IsNull(doc) Then') < at('getDocumentIndexes()'));
  assert.match(convert, /If IsNull\(doc\) Then\n {4}report = &quot;error LibreOffice did not load the \.docx&quot; &amp; Chr\(10\)\n {4}GoTo Done\n/);
  assert.ok(at('For pass = 1 To 2') < at('idx.getByIndex(i).update()'));
  assert.ok(at('idx.getByIndex(i).update()') < at('doc.storeToURL(outUrl, export())'));
  assert.ok(at('doc.storeToURL(outUrl, export())') < at('getAnchor().getString()'));
  assert.ok(at('supportsService(&quot;com.sun.star.text.ContentIndex&quot;)') < at('getAnchor().getString()'));
  // every way out goes through Done: the handler records the error and leaves error mode first (a
  // call that fails while a handler runs ends the Sub, and LibreOffice runs on with no report)
  assert.ok(!convert.includes('Exit Sub'), 'a way out of Convert that skips Done');
  assert.match(convert, /\nFailed:\n {2}report = &quot;error Basic error &quot; &amp; Err [^\n]*\n {2}Resume Done\nDone:\n/);
  assert.match(convert, /\nDone:\n {2}On Error Resume Next\n {2}WriteReport\(reportUrl, report\)\n {2}If Not IsNull\(doc\) Then doc\.close\(True\)\n {2}StarDesktop\.terminate\(\)\nEnd Sub\n$/);
  assert.equal(convert.split('StarDesktop.terminate()').length - 1, 1);
  assert.equal(convert.split('GoTo Done').length - 1, 2, 'the load failure and the success go to Done');
});
