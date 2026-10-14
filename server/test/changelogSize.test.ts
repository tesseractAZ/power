/**
 * v1.187.22 — the add-on CHANGELOG stays small enough for Home Assistant's Changelog dialog,
 * which renders the whole file. v1.38.3 trimmed it to 20 releases with only a sentence to hold
 * the line, and it grew back to 109 releases and ~330 KB. scripts/roll-changelog.mjs moves
 * older releases to CHANGELOG-ARCHIVE.md; this test runs its --check in CI, pins that the two
 * files together hold every release once, newest first, and drives the roll on fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  assert.ok(Buffer.byteLength(live) <= 40 * 1024 + 1024, `live file rolled to ~40 KB, got ${Buffer.byteLength(live)}`);
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
