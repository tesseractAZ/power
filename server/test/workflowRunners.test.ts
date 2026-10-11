/**
 * Every job runs on a PINNED runner image, never a moving `-latest` label.
 *
 * `ubuntu-latest` moves to Ubuntu 26.04 in a rollout from 2026-10-19 to 2026-11-19
 * (actions/runner-images#14748). That one move changes python3 (3.12 → 3.14) and Docker (28 → 29)
 * under every job at once, the docs jobs' apt installs (pandoc and LibreOffice come from the newer
 * archive), and possibly coreutils (26.04's coreutils package can pull in the uutils rewrite); and
 * CodeQL's supported platforms name only Ubuntu 22.04 and 24.04. During a rollout, jobs of one run
 * can even land on different images. The image moves deliberately, in one commit, like an action pin;
 * any `ubuntu-YY.MM[-arm]` label passes here, so that move is a label change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const PINNED = /^ubuntu-\d{2}\.\d{2}(?:-arm)?$/;
const INDIRECT = '${{ matrix.runner }}';

interface Label { file: string; line: number; key: string; value: string }

/** Every `runs-on:` value, and every matrix `runner:` value that a `runs-on: ${{ matrix.runner }}` reads. */
function labels(): Label[] {
  const out: Label[] = [];
  for (const file of FILES) {
    readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/).forEach((l, i) => {
      const m = /^\s*(?:-\s+)?(runs-on|runner):\s*(.*?)(?:\s+#.*)?\s*$/.exec(l);
      if (m) out.push({ file, line: i + 1, key: m[1], value: m[2].replace(/^(['"])(.*)\1$/, '$2') });
    });
  }
  return out;
}

test('★ each job has its own runs-on line, and the reader finds it (a reformat it cannot follow fails here)', () => {
  for (const file of FILES) {
    const lines = readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/);
    const start = lines.indexOf('jobs:');
    assert.ok(start >= 0, `${file}: no jobs: block`);
    const jobs = lines.slice(start + 1).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)).length;
    const runsOn = labels().filter((l) => l.file === file && l.key === 'runs-on').length;
    assert.ok(jobs > 0 && runsOn === jobs, `${file}: ${jobs} jobs but ${runsOn} runs-on lines`);
  }
});

test('★★ every runner is a pinned image (ubuntu-YY.MM[-arm]), never a moving -latest label', () => {
  const all = labels();
  const bad = all.filter((l) => {
    if (PINNED.test(l.value)) return false;
    // `runs-on: ${{ matrix.runner }}` is pinned through its matrix's `runner:` values, which are checked here too.
    return !(l.key === 'runs-on' && l.value === INDIRECT && all.some((r) => r.file === l.file && r.key === 'runner'));
  });
  assert.deepEqual(bad.map((l) => `${l.file}:${l.line} ${l.key}: ${l.value}`), []);
});