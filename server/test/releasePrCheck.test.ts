/**
 * scripts/check-release-pr.py fails a PR whose title and version change disagree, before it merges;
 * images.yml's resolve job and release.yml's next-version step accept only what tag-release.yml tags.
 *
 * The check compares GitHub's test-merge commit (HEAD^1, main as merged against, with HEAD) rather
 * than reading the title alone, so a branch cut before the last release is not a downgrade and a
 * raced duplicate bump is caught. It runs here with `python3 -I` against real `git merge --no-ff`
 * test merges, copied into each temporary repository's scripts/ so that its ROOT is that
 * repository; the environment is built from scratch (helpers/workflowRepo.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECK_PY, TEST_PATH, World, wf, world, stepText, runBlock } from './helpers/workflowRepo.js';

const IMAGES_YML = wf('images.yml');
const RELEASE_YML = wf('release.yml');

/* ── check-release-pr.py against real test merges ─────────────────────────── */

interface PrOpts {
  /** main's version before the PR (tagged v<base>), and extra tags: name → version of a side commit. */
  base?: string;
  extraTags?: Record<string, string>;
  /** main's commits after the branch was cut (a version, or the same file content). */
  mainAfter?: string;
  /** The PR's config.yaml (a version or raw text; undefined = unchanged) and CHANGELOG heading. */
  pr?: string | { raw: string };
  heading?: string | null;
  title: string;
  /** The PR's commit subject (default 'pr change'), and an optional second commit's subject. */
  subject?: string;
  secondCommit?: string;
  /** Run on the PR head itself (not a merge), optionally with BASE_REV. */
  noMerge?: boolean;
  baseRev?: string;
  noTags?: boolean;
}

function checkPr(o: PrOpts): { status: number | null; out: string } {
  const w = new World();
  try {
    const repo = w.dev;
    const cfg = (v: string | { raw: string }) => (typeof v === 'string' ? `name: Power\nversion: "${v}"\nslug: ecoflow_panel\n` : v.raw);
    const write = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
    const base = o.base ?? '1.0.0';
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    copyFileSync(CHECK_PY, join(repo, 'scripts/check-release-pr.py'));
    write('ecoflow_panel/config.yaml', cfg(base));
    write('ecoflow_panel/CHANGELOG.md', `# Changelog\n\n## v${base} — earlier\n\n- notes\n`);
    w.git(repo, 'add', '-A');
    w.git(repo, 'commit', '-q', '-m', `Release v${base}`);
    const c1 = w.git(repo, 'rev-parse', 'HEAD');
    if (!o.noTags) w.git(repo, 'tag', '-a', `v${base}`, '-m', 'release', c1);
    for (const [t, v] of Object.entries(o.extraTags ?? {})) {
      w.git(repo, 'checkout', '-q', '-b', `side-${t}`, c1);
      write('ecoflow_panel/config.yaml', cfg(v));
      w.git(repo, 'commit', '-q', '-am', `side ${t}`);
      w.git(repo, 'tag', '-a', t, '-m', t);
      w.git(repo, 'checkout', '-q', 'main');
    }
    // The PR branch, cut from c1.
    w.git(repo, 'checkout', '-q', '-b', 'pr', c1);
    write('feature.txt', 'the change\n');
    if (o.pr !== undefined) write('ecoflow_panel/config.yaml', cfg(o.pr));
    if (o.heading != null) {
      const cl = readFileSync(join(repo, 'ecoflow_panel/CHANGELOG.md'), 'utf8');
      write('ecoflow_panel/CHANGELOG.md', cl.replace('# Changelog\n\n', `# Changelog\n\n${o.heading}\n\n- new\n\n`));
    }
    w.git(repo, 'add', '-A');
    w.git(repo, 'commit', '-q', '-m', o.subject ?? 'pr change');
    if (o.secondCommit) {
      write('feature-2.txt', 'more\n');
      w.git(repo, 'add', '-A');
      w.git(repo, 'commit', '-q', '-m', o.secondCommit);
    }
    // main moves on after the branch was cut.
    w.git(repo, 'checkout', '-q', 'main');
    if (o.mainAfter !== undefined) {
      write('ecoflow_panel/config.yaml', cfg(o.mainAfter));
      write('ecoflow_panel/CHANGELOG.md', `# Changelog\n\n## v${o.mainAfter} — main\n\n- main\n\n## v${base} — earlier\n\n- notes\n`);
      w.git(repo, 'commit', '-q', '-am', `Release v${o.mainAfter}`);
    }
    // GitHub's test merge: HEAD^1 = main, HEAD^2 = the PR head.
    if (o.noMerge) w.git(repo, 'checkout', '-q', '--detach', 'pr');
    else {
      w.git(repo, 'checkout', '-q', '--detach', 'main');
      w.git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
    }
    const env: Record<string, string> = { ...w.env, PR_TITLE: o.title };
    if (o.baseRev) env.BASE_REV = o.baseRev;
    const r = spawnSync('python3', ['-I', join(repo, 'scripts/check-release-pr.py')], { cwd: repo, env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    w.close();
  }
}

const ok = (o: PrOpts, why: string) => { const r = checkPr(o); assert.equal(r.status, 0, `${why}: ${r.out}`); return r.out; };
const fails = (o: PrOpts, why: string, re?: RegExp) => {
  const r = checkPr(o);
  assert.equal(r.status, 1, `${why}: ${r.out}`);
  if (re) assert.match(r.out, re, why);
  return r.out;
};

test('★★★ PR check: a proper release passes; an ordinary PR passes untouched; a bump under another title fails', () => {
  ok({ pr: '1.0.1', heading: '## v1.0.1 — 2026-10-11', title: 'Release v1.0.1 — fixes' }, 'release');
  ok({ title: 'fix: something' }, 'ordinary PR');
  fails({ pr: '1.0.1', heading: '## v1.0.1 — x', title: 'fix: something' }, 'bump without a release title', /title it 'Release v1\.0\.1/);
  fails({ pr: '1.0.2', heading: '## v1.0.2 — x', title: 'Release v1.0.1 — mismatch' }, 'title and config disagree', /title it 'Release v1\.0\.2/);
});

test('★★★ PR check: a "Release v" title that changes no version fails (v1.130.0), including a raced duplicate bump', () => {
  fails({ title: 'Release v1.0.1 — forgot the bump' }, 'no bump', /Merging it releases nothing/);
  fails({ title: 'Release v1.0.0' }, 'names the base version', /Merging it releases nothing/);
  // Another PR already took main to 1.0.1; this one makes the same change and merges cleanly.
  // (Its CHANGELOG is left alone: two different sections would conflict, and a conflicting PR gets no merge ref.)
  fails({ mainAfter: '1.0.1', pr: '1.0.1', heading: null, title: 'Release v1.0.1 — duplicate' }, 'raced duplicate', /releases nothing/);
});

test('★★★ PR check: a one-commit PR\'s own subject is what a squash merge lands with, so it is held to the same rules', () => {
  // Renumbered in the train: the title was fixed, the single commit still names the old version.
  fails({ pr: '1.0.2', heading: '## v1.0.2 — x', title: 'Release v1.0.2 — x', subject: 'Release v1.0.1 — x' }, 'stale commit subject', /one commit is 'Release v1\.0\.1 — x'.*\n.*names v1\.0\.1 while config\.yaml says 1\.0\.2/);
  // The bump was dropped and the PR retitled; the commit still says Release.
  fails({ title: 'docs: wording', subject: 'Release v1.0.1 — wip' }, 'no bump, release subject', /releases? of v1\.0\.1 that changes no version/);
  // A matching subject, or a non-release subject, passes.
  ok({ pr: '1.0.1', heading: '## v1.0.1 — x', title: 'Release v1.0.1 — x', subject: 'Release v1.0.1 — x' }, 'matching subject');
  ok({ pr: '1.0.1', heading: '## v1.0.1 — x', title: 'Release v1.0.1 — x', subject: 'bump to 1.0.1' }, 'non-release subject');
  // Two commits: the squash subject is the PR title, so the commits' own subjects are not read.
  ok({ title: 'docs: wording', subject: 'docs: one', secondCommit: 'Release v1.0.1 — wip' }, 'two commits');
});

test('★★★ PR check: compares the test merge, so a branch cut before the last release is not read as a downgrade', () => {
  // main released 1.0.1 after this branch was cut at 1.0.0; the branch does not touch the version.
  ok({ mainAfter: '1.0.1', title: 'fix: stale branch' }, 'stale non-release branch');
});

test('★★★ PR check: a downgrade, a reused tag, or a version below the highest tag fails', () => {
  fails({ base: '1.0.1', extraTags: { 'v1.0.0': '1.0.0' }, pr: '1.0.0', heading: '## v1.0.0 — revert', title: 'Release v1.0.0' }, 'revert', /downgrade/);
  // main declares 1.0.2, never tagged (a lost run); lowering it to an untagged 1.0.1 above every tag is still a downgrade.
  fails({ base: '1.0.2', noTags: true, extraTags: { 'v1.0.0': '1.0.0' }, pr: '1.0.1', heading: '## v1.0.1 — x', title: 'Release v1.0.1' }, 'downgrade alone', /downgrade/);
  fails({ extraTags: { 'v1.0.1': '1.0.1' }, pr: '1.0.1', heading: '## v1.0.1 — x', title: 'Release v1.0.1' }, 'reused tag', /already tagged/);
  fails({ extraTags: { 'v1.0.5': '1.0.5' }, pr: '1.0.3', heading: '## v1.0.3 — x', title: 'Release v1.0.3' }, 'below the highest', /below the highest release tag, v1\.0\.5/);
  // Numeric, not string, order: 1.0.9 → 1.0.10 is an upgrade, and v1.10.0 is above v1.9.0.
  ok({ base: '1.0.9', pr: '1.0.10', heading: '## v1.0.10 — x', title: 'Release v1.0.10' }, '1.0.9 → 1.0.10');
  fails({ base: '1.9.0', extraTags: { 'v1.10.0': '1.10.0' }, pr: '1.9.5', heading: '## v1.9.5 — x', title: 'Release v1.9.5' }, 'below v1.10.0', /below the highest release tag, v1\.10\.0/);
  // A pre-release tag above it does not count.
  ok({ extraTags: { 'v1.1.0-rc1': '1.1.0-rc1' }, pr: '1.0.1', heading: '## v1.0.1 — x', title: 'Release v1.0.1' }, 'non-strict tag ignored');
});

test('★★ PR check: non-strict versions and a doubled version: key fail; a single-quoted version parses', () => {
  fails({ pr: '1.1.0-beta', heading: '## v1.1.0-beta', title: 'Release v1.1.0 — beta' }, 'pre-release', /not X\.Y\.Z/);
  fails({ pr: '1.0.01', heading: '## v1.0.01', title: 'Release v1.0.01' }, 'leading zero', /not X\.Y\.Z/);
  fails({ pr: { raw: 'version: "1.0.1"\nversion: "1.0.2"\n' }, heading: '## v1.0.1 — x', title: 'Release v1.0.1' }, 'declared twice', /2 top-level `version:` lines/);
  ok({ pr: { raw: "name: Power\nversion: '1.0.1'\n" }, heading: '## v1.0.1 — x', title: 'Release v1.0.1' }, 'single quotes');
});

test('★★★ PR check: the CHANGELOG heading must match images.yml\'s exact regex (`^## v?X\\b`)', () => {
  fails({ pr: '1.0.1', heading: null, title: 'Release v1.0.1' }, 'no section', /no '## 1\.0\.1' section/);
  for (const h of ['##  v1.0.1 — two spaces', '##\tv1.0.1 — tab', '##\nv1.0.1 — newline', '### v1.0.1 — h3', '## v1.0.10 — another']) {
    fails({ pr: '1.0.1', heading: h, title: 'Release v1.0.1' }, JSON.stringify(h), /no '## 1\.0\.1' section/);
  }
  for (const h of ['## v1.0.1', '## 1.0.1 — 2026-10-11', '## v1.0.1 — 2026-10-11']) {
    ok({ pr: '1.0.1', heading: h, title: 'Release v1.0.1' }, JSON.stringify(h));
  }
});

test('★★★ PR check: fails closed on a checkout that is not a merge commit, unless BASE_REV is set', () => {
  fails({ pr: '1.0.1', heading: '## v1.0.1', title: 'Release v1.0.1', noMerge: true }, 'not a merge', /HEAD is not a merge commit/);
  fails({ title: 'fix: something', noMerge: true }, 'not a merge, ordinary title', /HEAD is not a merge commit/);
  ok({ pr: '1.0.1', heading: '## v1.0.1', title: 'Release v1.0.1', noMerge: true, baseRev: 'main' }, 'BASE_REV (release.yml)');
  fails({ pr: '1.0.1', heading: '## v1.0.1', title: 'fix', noMerge: true, baseRev: 'main' }, 'BASE_REV still checks the title', /title it/);
  fails({ pr: '1.0.1', heading: '## v1.0.1', title: 'Release v1.0.1', noTags: true }, 'no tags visible', /no vX\.Y\.Z tags are visible/);
});

/* ── images.yml resolve, release.yml's next version ────────────────────────── */

function runStep(script: string, env: Record<string, string>, cwd: string): { status: number | null; out: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ef-step-'));
  try {
    const outFile = join(dir, 'github_output');
    writeFileSync(outFile, '');
    writeFileSync(join(dir, 'step.sh'), script);
    const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      cwd, env: { PATH: TEST_PATH, HOME: dir, LC_ALL: 'C', GITHUB_OUTPUT: outFile, ...env }, encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, output: readFileSync(outFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★ images.yml resolve accepts exactly what tag-release tags (strict X.Y.Z)', () => {
  const step = stepText(IMAGES_YML, /^ {6}- id: v$/);
  assert.match(step, /^ {10}INPUT_VERSION: \$\{\{ inputs\.version \}\}$/m);
  const script = runBlock(step);
  assert.ok(!script.includes('${{'), 'the dispatch input is read from env');
  const resolveV = (env: Record<string, string>) => runStep(script, env, tmpdir());
  assert.match(resolveV({ INPUT_VERSION: '1.187.18' }).output, /^version=1\.187\.18\ntag=v1\.187\.18$/m);
  assert.match(resolveV({ GITHUB_REF_NAME: 'v1.0.10' }).output, /^version=1\.0\.10$/m);
  for (const bad of ['1.188.0-beta', '1.187.018', '01.187.18', '1.187', 'v1.2.3', '']) {
    const r = resolveV(bad === '' ? { GITHUB_REF_NAME: 'main' } : { INPUT_VERSION: bad });
    assert.equal(r.status, 1, `${bad}: ${r.out}`);
  }
});

test('★★ release.yml bumps from the higher of config.yaml and the highest strict tag, and checks the PR before pushing it', () => {
  const step = stepText(RELEASE_YML, /^ {6}- name: Compute next version$/);
  const script = runBlock(step);
  assert.ok(!script.includes('${{'), 'inputs are read from env');
  world((w) => {
    const c1 = w.commit('1.0.0', 'Release v1.0.0');
    w.git(w.dev, 'tag', '-a', 'v1.0.0', '-m', 'x', c1);
    w.git(w.dev, 'checkout', '-q', '-b', 'side', c1);
    w.commit('1.0.5', 'side');
    w.git(w.dev, 'tag', '-a', 'v1.0.5', '-m', 'x');
    w.git(w.dev, 'tag', '-a', 'v1.0.9-rc1', '-m', 'x');
    w.git(w.dev, 'checkout', '-q', 'main');
    const next = (env: Record<string, string>) => runStep(script, { ...w.env, ...env }, w.dev);
    assert.match(next({ BUMP: 'patch', EXPLICIT: '' }).output, /^next=1\.0\.6$/m, 'above the v1.0.5 tag, not config.yaml\'s 1.0.0');
    assert.match(next({ BUMP: 'minor', EXPLICIT: '' }).output, /^next=1\.1\.0$/m);
    assert.match(next({ BUMP: 'patch', EXPLICIT: '1.2.0' }).output, /^next=1\.2\.0$/m);
    for (const bad of ['1.0.3', '1.0.5', '1.0.0', '01.2.0', '1.2.0-rc1']) {
      assert.equal(next({ BUMP: 'patch', EXPLICIT: bad }).status, 1, bad);
    }
  });
  const open = stepText(RELEASE_YML, /^ {6}- name: Open release PR \(auto-merge\)$/);
  const commitAt = open.indexOf('git commit -m "Release v${NEXT}"');
  const checkAt = open.indexOf('BASE_REV=origin/main PR_TITLE="Release v${NEXT}" python3 scripts/check-release-pr.py');
  const pushAt = open.indexOf('git push --force-with-lease origin "$branch"');
  assert.ok(commitAt >= 0 && checkAt > commitAt && pushAt > checkAt, 'commit, then the release-PR check, then the push');
});
