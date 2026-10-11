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

interface Use { file: string; line: number; raw: string; action: string | null; ref: string | null; comment: string | null }

// Every `uses:` key is read leniently first, then held to the strict shape, so a line the strict
// pattern cannot parse (a movable tag, `docker://`, words after the version) FAILS the pin test
// instead of silently dropping out of it. Only local `./` actions carry no pin.
const STRICT = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+)*)$/;

function uses(): Use[] {
  const out: Use[] = [];
  for (const file of FILES) {
    readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/).forEach((l, i) => {
      const m = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(l);
      if (!m) return;
      const raw = m[1].replace(/^(['"])(.*?)\1(?=\s|$)/, '$2');
      if (raw.startsWith('./')) return;
      const s = STRICT.exec(raw);
      // owner/repo is the unit of versioning: github/codeql-action/init and …/analyze share it.
      out.push(s
        ? { file, line: i + 1, raw, action: s[1].split('/').slice(0, 2).join('/'), ref: s[2], comment: s[3] }
        : { file, line: i + 1, raw, action: null, ref: null, comment: null });
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
  const bad = uses().filter((u) => u.action === null);
  assert.deepEqual(bad.map((u) => `${u.file}:${u.line} ${u.raw}`), []);
});

test('★★★ each action runs at ONE commit across all workflows', () => {
  const by = new Map<string, Use[]>();
  for (const u of uses()) if (u.action) by.set(u.action, [...(by.get(u.action) ?? []), u]);
  const drift: string[] = [];
  for (const [action, list] of by) {
    const pins = new Set(list.map((u) => `${u.ref} # ${u.comment}`));
    if (pins.size > 1) {
      drift.push(`${action}: ${list.map((u) => `${u.file}:${u.line} ${u.comment} ${(u.ref ?? '').slice(0, 7)}`).join(', ')}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('★★ no `#` line inside a build-args block (it reaches docker build as a build arg)', () => {
  const bad: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      // Any block-scalar header: `|`, `|-`, `|+`, `|2`, `>`, `>-`, with or without a header comment.
      const m = /^(\s*)(?:-\s+)?build-args:\s*[|>][-+0-9]*\s*(?:#.*)?$/.exec(l);
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
