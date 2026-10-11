/**
 * v1.187.17 — every workflow runs each action at ONE pinned commit.
 *
 * Dependabot ignores major updates here, so each workflow stayed on whichever major it was
 * written with: by v1.187.16 `actions/checkout` was v5.0.1 in four workflows and v7.0.1 in
 * codeql.yml, `actions/upload-artifact` v4.6.2 vs v7.0.1, and ci.yml's Dockerfile smoke build
 * ran the Node-20 majors of the docker actions that images.yml had left in v0.9.77. The
 * grouped github-actions update then proposed ONE version for every checkout (#516: v5.1.0),
 * which would have downgraded codeql.yml. With one pin per action the group moves them together.
 *
 * Also held here: a `#` line inside a `build-args: |` block is data, not a YAML comment —
 * ci.yml's smoke build passed two such lines to `docker build` as build args until v1.187.17.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

interface Use { file: string; line: number; action: string; ref: string; comment: string | null }

function uses(): Use[] {
  const out: Use[] = [];
  for (const file of FILES) {
    readFileSync(resolve(DIR, file), 'utf8').split('\n').forEach((l, i) => {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+?)@(\S+)(?:\s+#\s*(\S+))?\s*$/.exec(l);
      if (!m) return;
      // owner/repo is the unit of versioning: github/codeql-action/init and …/analyze share it.
      const action = m[1].split('/').slice(0, 2).join('/');
      out.push({ file, line: i + 1, action, ref: m[2], comment: m[3] ?? null });
    });
  }
  return out;
}

test('★ the reader finds the workflows and their actions (a reformat it cannot follow fails here)', () => {
  assert.ok(FILES.includes('ci.yml') && FILES.includes('images.yml') && FILES.includes('codeql.yml'));
  const all = uses();
  assert.ok(all.length >= 30, `only ${all.length} uses: lines found`);
  for (const a of ['actions/checkout', 'actions/upload-artifact', 'docker/build-push-action', 'github/codeql-action']) {
    assert.ok(all.some((u) => u.action === a), `${a} not found`);
  }
});

test('★★ every action is pinned to a full commit SHA with its version as a comment', () => {
  const bad = uses().filter((u) => !/^[0-9a-f]{40}$/.test(u.ref) || !/^v\d+(\.\d+)*$/.test(u.comment ?? ''));
  assert.deepEqual(bad.map((u) => `${u.file}:${u.line} ${u.action}@${u.ref} # ${u.comment}`), []);
});

test('★★★ each action runs at ONE commit across all workflows', () => {
  const by = new Map<string, Use[]>();
  for (const u of uses()) by.set(u.action, [...(by.get(u.action) ?? []), u]);
  const drift: string[] = [];
  for (const [action, list] of by) {
    const pins = new Set(list.map((u) => `${u.ref} # ${u.comment}`));
    if (pins.size > 1) {
      drift.push(`${action}: ${list.map((u) => `${u.file}:${u.line} ${u.comment} ${u.ref.slice(0, 7)}`).join(', ')}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('★★ no `#` line inside a build-args block (it reaches docker build as a build arg)', () => {
  const bad: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(resolve(DIR, file), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = /^(\s*)build-args:\s*\|\s*$/.exec(l);
      if (!m) return;
      const keyIndent = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const body = lines[j];
        if (body.trim() === '') continue;
        if (body.length - body.trimStart().length <= keyIndent) break;
        if (body.trimStart().startsWith('#')) bad.push(`${file}:${j + 1} ${body.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});
