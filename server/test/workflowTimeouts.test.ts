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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const pdf = j.steps.find((s) => /--convert-to pdf/.test(s.text));
    assert.ok(docx && pdf, 'docs steps not found');
    assert.match(docx!.text, /timeout -k \d+ \d+ python3 scripts\/build-docs-docx\.py/);
    assert.match(pdf!.text, /timeout -k \d+ \d+ libreoffice --headless/);
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
