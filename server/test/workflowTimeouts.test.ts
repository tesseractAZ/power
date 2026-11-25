/**
 * v1.187.3 — the release workflow's best-effort docs steps are BOUNDED, so a stall can
 * never cancel the job that creates the GitHub Release.
 *
 * images.yml promised that "a transient apt/pandoc hiccup can't turn a successful release
 * RED … the Release is still created". `continue-on-error` only covers a step that FAILS: on
 * the v1.187.1 run `sudo apt-get update` stalled on a mirror at 17:46:07Z and printed nothing
 * until the platform's 6 h job limit cancelled the job at 23:46:59Z, skipping 'Create GitHub
 * Release'. Nothing in the tree held the promise; these checks are what hold it now.
 *
 * The workflows are read with a deliberately small, indentation-based reader (no YAML
 * dependency in the server): jobs at two spaces, job keys at four, steps at `      - `. A
 * reformat that it cannot follow fails loudly (a job or step not found), never silently.
 * (review) The Release step's own script is also RUN, against a stub `gh`, for each docs
 * outcome: a bounded docs step can be killed mid-write, and an immutable Release must not
 * seal what it left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wf = (name: string) => readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8');

interface Step { name: string; text: string }
interface Job { text: string; timeout: number | null; steps: Step[] }

function job(yml: string, id: string): Job {
  const lines = yml.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `job ${id} not found`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  const t = body.find((l) => /^ {4}timeout-minutes: /.test(l));
  const steps: Step[] = [];
  let cur: string[] | null = null;
  for (const l of body) {
    if (/^ {6}- /.test(l)) { if (cur) steps.push(toStep(cur)); cur = [l]; }
    else if (cur) cur.push(l);
  }
  if (cur) steps.push(toStep(cur));
  return { text: body.join('\n'), timeout: t ? Number(t.split(':')[1]) : null, steps };
}
function toStep(lines: string[]): Step {
  const text = lines.join('\n');
  const n = /^ {6}(?:- | {2})name: (.+)$/m.exec(text);
  return { name: n ? n[1].trim() : lines[0].trim(), text };
}
/** A step-level key (eight spaces, or on the dash line). */
const key = (s: Step, k: string): string | null => {
  const m = new RegExp(`^ {6}(?:- | {2})${k}: (.+)$`, 'm').exec(s.text);
  return m ? m[1].trim() : null;
};
const stepNamed = (j: Job, name: string) => {
  const s = j.steps.find((x) => x.name === name);
  assert.ok(s, `step "${name}" not found`);
  return s!;
};

const IMAGES = wf('images.yml');
const CI = wf('ci.yml');
const RELEASE = job(IMAGES, 'release');
const DOCS_CI = job(CI, 'docs-docx');

test('★★★ the release job is bounded, far below the 6 h platform limit', () => {
  assert.ok(RELEASE.timeout != null, 'no timeout-minutes on the release job');
  assert.ok(RELEASE.timeout! <= 60, `release job bound ${RELEASE.timeout} min`);
});

test('★★★ every best-effort (continue-on-error) step has its own bound', () => {
  const bestEffort = RELEASE.steps.filter((s) => key(s, 'continue-on-error') === 'true');
  assert.deepEqual(bestEffort.map((s) => s.name), [
    'Ensure pandoc', 'Build documentation .docx', 'Ensure LibreOffice (docx → pdf)', 'Build documentation .pdf',
  ]);
  for (const s of bestEffort) {
    const t = Number(key(s, 'timeout-minutes'));
    assert.ok(Number.isFinite(t) && t > 0 && t <= 15, `${s.name}: timeout-minutes ${key(s, 'timeout-minutes')}`);
  }
});

test('★★★ the job bound exceeds the sum of its step bounds: a docs step at its limit cannot cancel the Release', () => {
  const bounded = RELEASE.steps.map((s) => Number(key(s, 'timeout-minutes') ?? 0));
  const sum = bounded.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0);
  assert.ok(RELEASE.timeout! >= sum + 5, `job ${RELEASE.timeout} min vs Σ steps ${sum} min (+5 for checkout and the gate)`);
});

test('★★★ the Release step is bounded, not best-effort, and does not wait on any docs step', () => {
  const s = stepNamed(RELEASE, 'Create GitHub Release (with docs asset)');
  assert.ok(Number(key(s, 'timeout-minutes')) > 0, 'a stalled API call must end');
  assert.equal(key(s, 'continue-on-error'), null, 'a Release that cannot be created is a red run');
  assert.equal(key(s, 'if'), "steps.gate.outputs.skip != 'true'", 'gated on the Release gate alone');
  // It sits after every docs step, so they run first and never block it.
  const idx = RELEASE.steps.indexOf(s);
  for (const d of RELEASE.steps.filter((x) => key(x, 'continue-on-error') === 'true')) {
    assert.ok(RELEASE.steps.indexOf(d) < idx, `${d.name} runs before the Release`);
  }
});

test('★★ the images are published before the Release job starts, never after it', () => {
  assert.match(RELEASE.text, /^ {4}needs: \[resolve, build\]$/m);
  const build = job(IMAGES, 'build');
  assert.doesNotMatch(build.text, /^ {4}needs: .*release/m, 'image publication must not wait on the Release');
});

test('★★★ every apt-get in both workflows runs under `timeout` with apt\'s own network timeouts', () => {
  for (const [file, yml] of [['images.yml', IMAGES], ['ci.yml', CI]] as const) {
    const calls = yml.split('\n').filter((l) => /\bapt-get\b/.test(l) && !/^\s*#/.test(l));
    assert.ok(calls.length >= 4, `${file}: ${calls.length} apt-get lines found`);
    for (const l of calls) {
      assert.match(l, /sudo timeout -k \d+ \d+ apt-get \$APT_OPTS (update|install)\b/,
        `${file}: unbounded apt-get: ${l.trim()}`);
    }
  }
  for (const j of [RELEASE, DOCS_CI]) {
    for (const s of j.steps.filter((x) => /apt-get/.test(x.text))) {
      assert.match(s.text, /APT_OPTS: -o Acquire::Retries=\d+ -o Acquire::http::Timeout=\d+ -o Acquire::https::Timeout=\d+/,
        `${s.name}: apt without connect/read timeouts`);
    }
  }
});

test('★★ the docs tools themselves run under `timeout`', () => {
  for (const j of [RELEASE, DOCS_CI]) {
    const docx = j.steps.find((s) => /build-docs-docx\.py \\/.test(s.text));
    // 1.209.1: the PDF step runs scripts/build-docs-pdf.py, which runs LibreOffice; the bound is on the script
    const pdf = j.steps.find((s) => /^ {10}\S.*scripts\/build-docs-pdf\.py/m.test(s.text));
    assert.ok(docx && pdf, 'docs steps not found');
    assert.match(docx!.text, /timeout -k \d+ \d+ python3 scripts\/build-docs-docx\.py/);
    assert.match(pdf!.text, /timeout -k \d+ \d+ python3 -I -B scripts\/build-docs-pdf\.py /);
  }
});

test('★★ the PR docs gate is bounded too: a stall is a red check in minutes, not a six-hour hold', () => {
  assert.ok(DOCS_CI.timeout != null && DOCS_CI.timeout <= 60, `docs-docx job bound ${DOCS_CI.timeout}`);
  for (const name of ['Ensure pandoc', 'Build .docx', 'Ensure LibreOffice (docx → pdf)', 'Build .pdf (render the .docx)']) {
    assert.ok(Number(key(stepNamed(DOCS_CI, name), 'timeout-minutes')) > 0, `${name} unbounded`);
  }
  // A hard gate stays a hard gate.
  assert.ok(!DOCS_CI.steps.some((s) => key(s, 'continue-on-error') === 'true'));
});

/* ── v1.187.3 (review): a bounded docs step must not seal a truncated asset ── */

/** A step's `run: |` block, de-indented, exactly as the runner would write it to disk. */
function runBlock(s: Step): string {
  const lines = s.text.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(at >= 0, `${s.name}: no run block`);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

const RELEASE_STEP = stepNamed(RELEASE, 'Create GitHub Release (with docs asset)');
// A strict X.Y.Z: the Latest lookup counts only strict vX.Y.Z tags (a `-test` suffix would not be one).
const TAG = 'v1.2.3';
const V = '1.2.3';
const DOCX = `Power-Documentation-v${V}.docx`;
const PDF = `Power-Documentation-v${V}.pdf`;

/** Runs the Release step's own script against a stub `gh` and returns the assets it attached. */
function releaseAssets(o: { docx: string; pdf: string; files: Partial<Record<'docx' | 'pdf', string>> }): string[] {
  const script = runBlock(RELEASE_STEP).replace(/\$\{\{ needs\.resolve\.outputs\.tag \}\}/g, TAG);
  assert.ok(!script.includes('${{'), `an expression the test does not substitute: ${script}`);
  const dir = mkdtempSync(join(tmpdir(), 'ef-release-step-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GH_ARGS"\n');
    chmodSync(join(bin, 'gh'), 0o755);
    if (o.files.docx != null) writeFileSync(join(dir, DOCX), o.files.docx);
    if (o.files.pdf != null) writeFileSync(join(dir, PDF), o.files.pdf);
    writeFileSync(join(dir, 'step.sh'), script);
    const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`, GH_ARGS: join(dir, 'gh.args'), GH_TOKEN: 'none', V,
        DOCX_OUTCOME: o.docx, PDF_OUTCOME: o.pdf,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the step failed: ${r.stderr}`);
    const args = readFileSync(join(dir, 'gh.args'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(args.slice(0, 3), ['release', 'create', TAG], 'the Release is created whatever the docs did');
    return args.filter((a) => a === DOCX || a === PDF);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★★ the Release attaches a document only when its build step succeeded and left a non-empty file', () => {
  const both = { docx: 'PK-docx', pdf: '%PDF-1.7' };
  assert.deepEqual(releaseAssets({ docx: 'success', pdf: 'success', files: both }), [DOCX, PDF]);
  // A .docx build killed mid-write (`timeout` or its step bound): the file is there, truncated.
  assert.deepEqual(releaseAssets({ docx: 'failure', pdf: 'skipped', files: { docx: 'PK-trunc' } }), []);
  assert.deepEqual(releaseAssets({ docx: 'cancelled', pdf: 'skipped', files: { docx: 'PK-trunc' } }), []);
  // LibreOffice stalled after writing part of the PDF.
  assert.deepEqual(releaseAssets({ docx: 'success', pdf: 'failure', files: both }), [DOCX]);
  // A step that reported success but left a zero-byte file.
  assert.deepEqual(releaseAssets({ docx: 'success', pdf: 'success', files: { docx: 'PK-docx', pdf: '' } }), [DOCX]);
  // No docs at all: the Release is still created, with no asset.
  assert.deepEqual(releaseAssets({ docx: 'skipped', pdf: 'skipped', files: {} }), []);
});

test('★★ the Release reads each build step\'s OUTCOME, and the PDF renders only from a .docx that built', () => {
  const docx = stepNamed(RELEASE, 'Build documentation .docx');
  const pdf = stepNamed(RELEASE, 'Build documentation .pdf');
  assert.equal(key(docx, 'id'), 'docx');
  assert.equal(key(pdf, 'id'), 'pdf');
  // `outcome` is the result before continue-on-error; `conclusion` is always success there.
  assert.match(RELEASE_STEP.text, /^ {10}DOCX_OUTCOME: \$\{\{ steps\.docx\.outcome \}\}$/m);
  assert.match(RELEASE_STEP.text, /^ {10}PDF_OUTCOME: \$\{\{ steps\.pdf\.outcome \}\}$/m);
  assert.match(key(pdf, 'if') ?? '', /steps\.docx\.outcome == 'success'/, 'a truncated .docx renders a truncated PDF');
  assert.match(runBlock(pdf), /^test -s "Power-Documentation-v\$\{V\}\.pdf"$/m, 'no PDF is a failed step, not a green one');
});

/** Runs the Release step against a stub `gh` and a stub `git` listing `tags` (null = the lookup fails). */
function releaseArgs(tags: string[] | null): string[] {
  const script = runBlock(RELEASE_STEP).replace(/\$\{\{ needs\.resolve\.outputs\.tag \}\}/g, TAG);
  const dir = mkdtempSync(join(tmpdir(), 'ef-release-latest-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GH_ARGS"\n');
    const lines = (tags ?? []).map((t) => `0000000000000000000000000000000000000000\trefs/tags/${t}`).join('\n');
    writeFileSync(join(bin, 'git'), tags == null ? '#!/bin/sh\necho "remote: Not Found" >&2\nexit 128\n' : `#!/bin/sh\nprintf '%s\\n' '${lines.replace(/\t/g, '\\t')}' | sed 's/\\\\t/\t/'\n`);
    for (const f of ['gh', 'git']) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(dir, 'step.sh'), script);
    const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, GH_ARGS: join(dir, 'gh.args'), GH_TOKEN: 'none', V, GITHUB_REPOSITORY: 'owner/repo', DOCX_OUTCOME: 'failure', PDF_OUTCOME: 'failure' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the step failed: ${r.stderr}`);
    return readFileSync(join(dir, 'gh.args'), 'utf8').split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★ only the highest version is marked Latest; a re-run older release is not; a failed lookup leaves it to GitHub', () => {
  assert.ok(releaseArgs(['v1.2.2', TAG]).includes('--latest=true'), 'the highest tag is Latest');
  assert.ok(releaseArgs([TAG, 'v99.0.0']).includes('--latest=false'), 'an older version re-run after a newer one is not Latest');
  assert.ok(!releaseArgs(null).some((a) => a.startsWith('--latest')), 'a failed lookup passes no flag (GitHub decides)');
});

test('★★ "highest" counts strict vX.Y.Z tags only, compared as numbers (sort -V ranked v1.2.3-rc1 above v1.2.3)', () => {
  // A stray pre-release or malformed tag above the release must not demote it.
  assert.ok(releaseArgs(['v1.2.2', TAG, 'v1.2.3-rc1', 'v1.2.4-beta', 'v01.9.9', 'vnext']).includes('--latest=true'));
  // Numeric, not lexicographic: v1.2.10 is above v1.2.3 although "3" > "1".
  assert.ok(releaseArgs(['v1.2.2', 'v1.2.10', TAG]).includes('--latest=false'));
  assert.ok(releaseArgs([TAG, 'v1.10.0']).includes('--latest=false'));
  // Only non-strict tags: no strict highest, so GitHub decides.
  assert.ok(!releaseArgs(['v1.2.3-rc1']).some((a) => a.startsWith('--latest')));
});

/* ── 2026-11-19: the PR docs job leaves the runner's regional apt mirror, on either cloud ── */
// The runner's /etc/apt/apt-mirrors.txt lists a regional mirror first and the cloud picks it:
// azure.archive.ubuntu.com on an Azure runner, <region>.ec2.archive.ubuntu.com on an AWS one. apt
// leaves a mirror only when it fails, never when it is slow, and the 10-26 filter matched only the
// Azure name: on AWS runners LibreOffice's 100 MB took 1-2 min, against 3-12 s from the main archive.

const MIRROR_STEP = stepNamed(DOCS_CI, 'Prefer the main Ubuntu archive');
const MAIN_ARCHIVE = 'https://archive.ubuntu.com/ubuntu/\tpriority:2\n';
const SECURITY_ARCHIVE = 'https://security.ubuntu.com/ubuntu/\tpriority:3\n';
const AZURE_FIRST = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n';
const AWS_FIRST = 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\n';

/** Runs the mirror step's own script against a mirror list (null: the runner has none). */
function mirrorStep(list: string | null): { left: string | null; out: string } {
  const LIST = '/etc/apt/apt-mirrors.txt';
  const script = runBlock(MIRROR_STEP);
  assert.ok(script.includes(LIST), `the step no longer edits ${LIST}`);
  const dir = mkdtempSync(join(tmpdir(), 'ef-mirror-step-'));
  try {
    const bin = join(dir, 'bin');
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    // `sudo` runs its command as the test's user; the list itself is a temp file.
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    chmodSync(join(bin, 'sudo'), 0o755);
    const f = join(dir, 'apt-mirrors.txt');
    if (list != null) writeFileSync(f, list);
    writeFileSync(join(dir, 'step.sh'), script.split(LIST).join(f));
    // The runner's shell for `run:` is bash -e -o pipefail.
    const r = spawnSync('bash', ['-e', '-o', 'pipefail', join(dir, 'step.sh')], {
      cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the step failed: ${r.stderr}`);
    return { left: list == null ? null : readFileSync(f, 'utf8'), out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★★ the regional mirror is dropped on either cloud, the main and security archives kept', () => {
  for (const first of [AZURE_FIRST, AWS_FIRST]) {
    const { left, out } = mirrorStep(first + MAIN_ARCHIVE + SECURITY_ARCHIVE);
    assert.equal(left, MAIN_ARCHIVE + SECURITY_ARCHIVE, `left after dropping ${first.trim()}`);
    assert.ok(out.includes(`dropped: ${first.trim()}`), `the log names what was dropped: ${out}`);
  }
});

test('★★★ nothing is dropped unless the main archive stays listed, and a list without a regional mirror is left as it is', () => {
  // Dropping the regional mirror here would leave apt only the security pocket.
  const noMain = AZURE_FIRST + SECURITY_ARCHIVE;
  assert.equal(mirrorStep(noMain).left, noMain);
  const noRegional = MAIN_ARCHIVE + SECURITY_ARCHIVE;
  const r = mirrorStep(noRegional);
  assert.equal(r.left, noRegional);
  assert.ok(!r.out.includes('dropped:'), r.out);
  // A runner image with no mirror list at all: the step passes and changes nothing.
  assert.equal(mirrorStep(null).left, null);
});

test('★★ the mirror step runs before any package is fetched', () => {
  const at = DOCS_CI.steps.indexOf(MIRROR_STEP);
  for (const s of DOCS_CI.steps.filter((x) => /apt-get|dpkg|curl/.test(x.text))) {
    assert.ok(DOCS_CI.steps.indexOf(s) > at, `${s.name} fetches before the mirror list is fixed`);
  }
});

/** A step's commands, one per line, continuation-free (the docs job's are `&&`-chained per line). */
const commands = (s: Step) => runBlock(s).split('\n').map((l) => l.trim()).filter(Boolean);

test('★★ every apt install in the docs job downloads under its bound first, then installs from the cache', () => {
  // A bound that fires while dpkg unpacks leaves a half-configured package and a dpkg holding
  // the lock (10-26). Downloading first puts the long, network-bound part where a kill is harmless.
  let installs = 0;
  for (const s of DOCS_CI.steps.filter((x) => /^ {8}run: \|$/m.test(x.text))) {
    const pending = new Set<string>();
    for (const c of commands(s)) {
      const m = /apt-get \$APT_OPTS install -y( --download-only)?( --no-install-recommends)? ([^&;]+?)(?: &&|;|$)/.exec(c);
      if (!m) continue;
      if (m[1]) { pending.add(m[3]); continue; }
      assert.ok(pending.delete(m[3]), `${s.name}: ${m[3]} installs without a bounded download first`);
      installs++;
    }
    assert.equal(pending.size, 0, `${s.name}: downloaded but never installed: ${[...pending]}`);
  }
  assert.equal(installs, 2, 'pandoc (fallback) and LibreOffice');
});

test('★★ every docs-job apt step waits for the dpkg lock', () => {
  for (const s of DOCS_CI.steps.filter((x) => /apt-get/.test(x.text))) {
    assert.match(s.text, /APT_OPTS: .*-o DPkg::Lock::Timeout=\d+/, `${s.name}: apt fails at once on a held dpkg lock`);
  }
});

test('★★★ pandoc is the pinned upstream .deb, checked before it is installed; the apt fallback says when it ran', () => {
  const s = stepNamed(DOCS_CI, 'Ensure pandoc');
  const url = /PANDOC_DEB_URL: (\S+)/.exec(s.text)?.[1] ?? '';
  const m = /^https:\/\/github\.com\/jgm\/pandoc\/releases\/download\/([0-9.]+)\/pandoc-\1-1-amd64\.deb$/.exec(url);
  assert.ok(m, `PANDOC_DEB_URL ${url}`);
  // The version Ubuntu 26.04 packages, so the apt fallback builds the same manual.
  assert.equal(m![1], '3.7.0.2');
  assert.match(s.text, /PANDOC_DEB_SHA256: [0-9a-f]{64}\n/);
  const run = runBlock(s);
  const check = run.indexOf('| sha256sum -c - &&');
  assert.ok(check >= 0 && check < run.indexOf('dpkg -i'), 'the .deb is installed only after its checksum matched');
  const warn = run.indexOf('::warning::');
  assert.ok(warn >= 0 && warn < run.indexOf('apt-get'), 'a pin that stopped matching must not pass silently as an apt install');
});

test('★★ each docs-job step\'s bound covers its commands\' bounds, and the job\'s covers the steps\' + 5', () => {
  let sum = 0;
  for (const s of DOCS_CI.steps) {
    const t = Number(key(s, 'timeout-minutes') ?? 0);
    sum += t;
    let need = 0;
    for (const b of s.text.matchAll(/timeout -k (\d+) (\d+) /g)) need += Number(b[1]) + Number(b[2]);
    for (const c of s.text.matchAll(/curl [^\n]*--retry (\d+) --max-time (\d+) /g)) need += (Number(c[1]) + 1) * Number(c[2]);
    if (need > 0) assert.ok(need <= t * 60, `${s.name}: commands bounded at ${need} s, step at ${t} min`);
  }
  assert.ok(DOCS_CI.timeout! >= sum + 5, `docs-docx job ${DOCS_CI.timeout} min vs Σ steps ${sum} min (+5 for checkout and the upload)`);
});

/* ── 1.209.1: both workflows render the PDF with its contents updated ─────── */
// A plain `libreoffice --convert-to pdf` does not update a document's indexes: every release PDF
// up to 1.209.0 printed "Table of Contents" over nothing, and the step passed.

test('★★★ both workflows render the PDF with scripts/build-docs-pdf.py, from the .docx the step before wrote; neither converts with a bare --convert-to', () => {
  for (const [file, yml] of [['images.yml', IMAGES], ['ci.yml', CI]] as const) {
    const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l));
    assert.deepEqual(lines.filter((l) => /--convert-to\b/.test(l)), [], `${file} converts without updating the contents`);
  }
  const cases = [
    { j: RELEASE, docx: 'Build documentation .docx', pdf: 'Build documentation .pdf' },
    { j: DOCS_CI, docx: 'Build .docx', pdf: 'Build .pdf (render the .docx)' },
  ];
  for (const { j, docx, pdf } of cases) {
    const out = /--output "([^"]+\.docx)"/.exec(runBlock(stepNamed(j, docx)))?.[1];
    assert.ok(out, `${docx}: no --output`);
    const run = commands(stepNamed(j, pdf));
    assert.equal(run[0], `timeout -k 10 240 python3 -I -B scripts/build-docs-pdf.py "${out}"`, `${pdf}: ${run[0]}`);
    // the PDF it checks is the one the script writes: beside the .docx, with a .pdf suffix
    const want = out.replace(/\.docx$/, '.pdf');
    assert.ok(run.some((c) => c === `test -s "${want}"` || c === `test -s ${want}`), `${pdf}: no test -s of ${want}`);
    assert.ok(j.steps.indexOf(stepNamed(j, docx)) < j.steps.indexOf(stepNamed(j, pdf)));
  }
});

test('★★ the release renders the PDF only where the tagged tree has the script: an older tag skips it rather than attaching a PDF with no contents', () => {
  for (const name of ['Ensure LibreOffice (docx → pdf)', 'Build documentation .pdf']) {
    assert.match(key(stepNamed(RELEASE, name), 'if') ?? '', /hashFiles\('scripts\/build-docs-pdf\.py'\) != ''/, name);
  }
});
