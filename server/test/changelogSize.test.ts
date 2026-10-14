/**
 * v1.187.22 — the add-on CHANGELOG stays small enough for Home Assistant's Changelog dialog,
 * which renders the whole file. v1.38.3 trimmed it to 20 releases with only a sentence to hold
 * the line, and it grew back to 109 releases and ~330 KB. scripts/roll-changelog.mjs moves
 * older releases to CHANGELOG-ARCHIVE.md; this test runs its --check in CI, pins that the two
 * files together hold every release once, newest first, with bare `## X.Y.Z` headings in the live
 * file, drives the roll on fixtures, and runs release.yml's changelog step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stepText, runBlock } from './helpers/workflowRepo.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'roll-changelog.mjs');
const LIVE = join(ROOT, 'ecoflow_panel', 'CHANGELOG.md');
const ARCHIVE = join(ROOT, 'ecoflow_panel', 'CHANGELOG-ARCHIVE.md');
const FOOTER_HEADING = '## Older releases';

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function headings(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('## '));
}

function version(h: string): [number, number, number] | null {
  const m = /^## v?(\d+)\.(\d+)\.(\d+)/.exec(h);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function older(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

test('the committed CHANGELOG.md is within the size limit (roll-changelog --check)', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('CHANGELOG.md + CHANGELOG-ARCHIVE.md hold every release once, newest first, and the live file ends with the archive link', () => {
  const live = readFileSync(LIVE, 'utf8');
  const archive = readFileSync(ARCHIVE, 'utf8');
  const liveHeads = headings(live);
  assert.equal(liveHeads.filter((h) => h === FOOTER_HEADING).length, 1, 'one "Older releases" section');
  assert.equal(liveHeads[liveHeads.length - 1], FOOTER_HEADING, 'the "Older releases" section is last');
  assert.match(live.slice(live.lastIndexOf(FOOTER_HEADING)), /CHANGELOG-ARCHIVE\.md\]\(https:\/\/github\.com\//, 'an absolute link (the HA dialog cannot follow a relative one)');
  const all = [...liveHeads.slice(0, -1), ...headings(archive)];
  assert.ok(all.length > 100, `expected the full release history, found ${all.length} headings`);
  for (let i = 0; i < all.length; i++) {
    const v = version(all[i]);
    assert.ok(v, `not a release heading: ${all[i]}`);
    if (i > 0) assert.ok(older(v!, version(all[i - 1])!), `out of order or duplicated: "${all[i - 1]}" then "${all[i]}"`);
  }
});

/* ── the roll on fixtures ──────────────────────────────────────────────── */

function section(v: string, bytes: number): string {
  const head = `## ${v}\n\n`;
  return head + `${'x'.repeat(Math.max(0, bytes - head.length - 2))}\n\n`;
}

function fixture(liveText: string, archiveText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-changelog-'));
  const live = join(dir, 'CHANGELOG.md');
  const archive = join(dir, 'CHANGELOG-ARCHIVE.md');
  writeFileSync(live, liveText);
  writeFileSync(archive, archiveText);
  const args = ['--live', live, '--archive', archive];
  return { dir, live, archive, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ARCHIVE_PREAMBLE = '# Archive\n\n_Older releases._\n\n';

test('an oversized file: the oldest releases move to the TOP of the archive, unedited, and nothing is lost', (t) => {
  const releases = Array.from({ length: 30 }, (_, i) => section(`2.0.${29 - i}`, 3000));
  const f = fixture(releases.join(''), ARCHIVE_PREAMBLE + section('1.9.9', 500) + section('1.9.8', 500));
  t.after(f.cleanup);
  assert.equal(run(['--check', ...f.args]).status, 1, '90 KB is over the limit');
  const r = run(f.args);
  assert.equal(r.status, 0, r.stderr);
  const live = readFileSync(f.live, 'utf8');
  const archive = readFileSync(f.archive, 'utf8');
  assert.ok(Buffer.byteLength(live) <= 32 * 1024 + 1024, `live file rolled to ~32 KiB, got ${Buffer.byteLength(live)}`);
  assert.equal(run(['--check', ...f.args]).status, 0);
  const kept = headings(live).slice(0, -1);
  assert.equal(kept[0], '## 2.0.29', 'the newest release stays');
  assert.ok(archive.startsWith(ARCHIVE_PREAMBLE), 'the archive preamble is kept');
  assert.deepEqual(
    [...kept, ...headings(archive)],
    [...Array.from({ length: 30 }, (_, i) => `## 2.0.${29 - i}`), '## 1.9.9', '## 1.9.8'],
    'every release exactly once, newest first: the moved ones sit above the earlier archive',
  );
  for (const s of releases.slice(kept.length)) assert.ok(archive.includes(s.trimEnd()), 'moved sections are unedited');
});

test('the roll is idempotent, and a file within the target is left alone', (t) => {
  const f = fixture(Array.from({ length: 30 }, (_, i) => section(`2.0.${29 - i}`, 3000)).join(''), ARCHIVE_PREAMBLE);
  t.after(f.cleanup);
  run(f.args);
  const live1 = readFileSync(f.live, 'utf8');
  const archive1 = readFileSync(f.archive, 'utf8');
  const r = run(f.args);
  assert.match(r.stdout, /nothing to do/);
  assert.equal(readFileSync(f.live, 'utf8'), live1);
  assert.equal(readFileSync(f.archive, 'utf8'), archive1);
  assert.equal(headings(live1).filter((h) => h === FOOTER_HEADING).length, 1, 'the footer is not appended twice');
});

test('the newest release is kept even when it alone is larger than the target', (t) => {
  const f = fixture(section('3.0.0', 50 * 1024) + section('2.9.9', 1000), ARCHIVE_PREAMBLE);
  t.after(f.cleanup);
  assert.equal(run(f.args).status, 0);
  assert.deepEqual(headings(readFileSync(f.live, 'utf8')), ['## 3.0.0', FOOTER_HEADING]);
  assert.deepEqual(headings(readFileSync(f.archive, 'utf8')), ['## 2.9.9']);
});

test('release.yml rolls the changelog after prepending the new section, and commits the archive with it', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const prepend = yml.indexOf('with open("ecoflow_panel/CHANGELOG.md", "w") as f:');
  const roll = yml.indexOf('node scripts/roll-changelog.mjs\n');
  const commit = yml.indexOf('git commit -m "Release v${NEXT}"');
  assert.ok(prepend > 0 && roll > prepend && commit > roll, 'prepend → roll → commit');
  assert.match(yml, /git add ecoflow_panel\/config\.yaml ecoflow_panel\/CHANGELOG\.md ecoflow_panel\/CHANGELOG-ARCHIVE\.md\n/);
});

test('every release heading in the live CHANGELOG.md is a bare `## X.Y.Z` (Home Assistant slices the update notes only on those)', () => {
  const heads = headings(readFileSync(LIVE, 'utf8')).filter((h) => h !== FOOTER_HEADING);
  const bad = heads.filter((h) => !/^## \d+\.\d+\.\d+$/.test(h));
  assert.deepEqual(bad, [], 'a date or suffix on a heading makes the update dialog show the whole file');
});

test("release.yml's changelog step writes a bare heading, demotes headings inside the notes, and rolls", (t) => {
  const step = stepText(readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'), /^ {6}- name: Update config\.yaml \+ CHANGELOG\.md$/);
  const dir = mkdtempSync(join(tmpdir(), 'release-changelog-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'ecoflow_panel'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'roll-changelog.mjs'));
  writeFileSync(join(dir, 'ecoflow_panel', 'config.yaml'), 'name: x\nversion: "2.0.29"\n');
  writeFileSync(join(dir, 'ecoflow_panel', 'CHANGELOG.md'), Array.from({ length: 30 }, (_, i) => section(`2.0.${29 - i}`, 3000)).join(''));
  writeFileSync(join(dir, 'ecoflow_panel', 'CHANGELOG-ARCHIVE.md'), ARCHIVE_PREAMBLE);
  const notes = join(dir, 'notes.md');
  writeFileSync(notes, '## Highlights\n\n- one\n\n# Also\n\n- two\n');
  const script = join(dir, 'step.sh');
  writeFileSync(script, runBlock(step));
  const r = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NEXT: '2.0.30', NOTES_FILE: notes, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const live = readFileSync(join(dir, 'ecoflow_panel', 'CHANGELOG.md'), 'utf8');
  const heads = headings(live);
  assert.equal(heads[0], '## 2.0.30', 'a bare, undated heading');
  assert.ok(heads.every((h) => h === FOOTER_HEADING || /^## \d+\.\d+\.\d+$/.test(h)), `only version headings and the footer: ${heads.join(' | ')}`);
  assert.match(live, /^### Highlights$/m, 'a ## line inside the notes is demoted');
  assert.match(live, /^### Also$/m, 'a # line inside the notes is demoted');
  assert.match(readFileSync(join(dir, 'ecoflow_panel', 'config.yaml'), 'utf8'), /^version: "2\.0\.30"$/m);
  assert.ok(Buffer.byteLength(live) <= 48 * 1024, 'the step rolled the oversized file');
  assert.ok(headings(readFileSync(join(dir, 'ecoflow_panel', 'CHANGELOG-ARCHIVE.md'), 'utf8')).includes('## 2.0.0'), 'the oldest release moved to the archive');
});
