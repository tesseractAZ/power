import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OPTIONS } from '../src/config.js';
import {
  SRC, MANIFEST_PATH, BASELINE, ENV_PARAM_ALLOWLIST, PERMANENT_EXCEPTION, ENV_TYPE_RE, walk, readsOf, measure, envParamIdents,
  type FileReads,
} from './processEnvScan.js';

/**
 * v1.191.0 (S2) — the process.env ratchet (plan 2.3 P1, CA9).
 *
 * config.ts is the one module that reads `process.env`; every other read is a consumer that has not
 * moved onto the option table yet. The target is zero, with one permanent exception: backupHook.mjs
 * runs under `docker exec` as plain JavaScript and cannot import TypeScript.
 *
 * v1.191.0 (review) — the ratchet PINS the reads, not just their counts. A count let a name be
 * swapped for another (ALERT_ONSET_PATH → UNREGISTERED_NEW_KNOB left every figure unchanged), a new
 * knob be added through a helper that reads `process.env[name]` (selfVitals.ts `num`), and the
 * environment be reached as `import { env } from 'node:process'`, `const { env } = process` or
 * `process['env'].X`, none of which the textual `process.env` count saw. Now:
 *  - processEnvReads.json holds, per file, the occurrences of any spelling of `process.env`, the exact
 *    set of names read (static `.NAME`, `?.NAME`, `['NAME']`, and the literal first argument of each
 *    listed dynamic-name helper), and the bare references that pass the whole environment on. The
 *    tree must match it exactly: a new name, file or reference fails; one that goes away fails until
 *    the manifest shrinks with it. Regenerate with the command in the manifest's `_how`, then read the
 *    diff: it may only remove.
 *  - a dynamic read (`process.env[expr]`) is allowed only inside the listed helpers, each called only
 *    with a string literal;
 *  - importing `process`/`node:process`, destructuring `process`, aliasing it, or indexing an object
 *    by the string 'process' fails outright outside config.ts.
 * The second rule covers the indirect readers a textual scan misses: a function that takes the
 * environment as a parameter reads it without naming `process.env`. Three exist today and are listed;
 * the list shrinks and never grows. v1.191.0 (review 3) — and the names they read through that
 * parameter (`env.NAME`, `env?.NAME`, `env['NAME']`) are collected into the same per-file manifest;
 * a computed name or a destructuring of the parameter is a problem (processEnvScan.ts envParamIdents).
 */
const manifest = (): Record<string, FileReads> => {
  const { _how, ...files } = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
  void _how;
  return files as Record<string, FileReads>;
};

test('★ process.env reads outside config.ts never increase (occurrences, lines, files, distinct names)', () => {
  const m = measure();
  const over = (['occurrences', 'lines', 'files', 'names'] as const).filter((k) => m[k] > BASELINE[k]);
  assert.deepEqual(over.map((k) => `${k}: ${m[k]} > baseline ${BASELINE[k]}`), [],
    'a new process.env read outside config.ts: register the key in OPTIONS and read it through config');
  const under = (['occurrences', 'lines', 'files', 'names'] as const).filter((k) => m[k] < BASELINE[k]);
  assert.deepEqual(under.map((k) => `${k}: ${m[k]} < baseline ${BASELINE[k]}`), [],
    'the count fell — lower BASELINE in this test to the new figures so the ratchet holds there');
});

test('★★ the exact reads are pinned: per file, every name, the occurrences and the whole-environment references', () => {
  const m = measure();
  const want = manifest();
  const diffs: string[] = [];
  for (const rel of [...new Set([...Object.keys(want), ...Object.keys(m.byFile)])].sort()) {
    const a = want[rel]; const b = m.byFile[rel];
    if (!a) { diffs.push(`${rel}: a new module reads the environment (${b.names.join(', ') || `${b.bare} whole-environment reference(s)`})`); continue; }
    if (!b) { diffs.push(`${rel}: no longer reads the environment — remove it from processEnvReads.json`); continue; }
    const added = b.names.filter((n) => !a.names.includes(n));
    const gone = a.names.filter((n) => !b.names.includes(n));
    if (added.length) diffs.push(`${rel}: new name(s) ${added.join(', ')} — register the key in OPTIONS and read it through config.ts`);
    if (gone.length) diffs.push(`${rel}: ${gone.join(', ')} no longer read here — shrink processEnvReads.json`);
    for (const k of ['occurrences', 'lines', 'bare', 'dynamic'] as const) {
      if (a[k] !== b[k]) diffs.push(`${rel}: ${k} ${b[k]} (pinned ${a[k]})${b[k] > a[k] ? ' — a new read' : ' — shrink processEnvReads.json'}`);
    }
  }
  assert.deepEqual(diffs, []);
  // The manifest's totals are the baseline's (one cannot grow without the other).
  const files = Object.values(want);
  assert.equal(files.reduce((s, f) => s + f.occurrences, 0), BASELINE.occurrences);
  assert.equal(new Set(files.flatMap((f) => f.names)).size, BASELINE.names);
});

test('★★ no module reaches the environment by an unpinned route (import, destructuring, alias, a computed name)', () => {
  assert.deepEqual(measure().problems, []);
});

test('★★ the unregistered names are exactly the pinned ones (a name with no OPTIONS row never joins them silently)', () => {
  const m = measure();
  const unregistered = [...m.nameSet].filter((n) => !(n in OPTIONS)).sort();
  const pinned = [...new Set(Object.values(manifest()).flatMap((f) => f.names))].filter((n) => !(n in OPTIONS)).sort();
  assert.deepEqual(unregistered, pinned);
});

test('the scanner sees every route the review found (fixtures)', () => {
  const r = (src: string, helper?: string) => readsOf(src, helper);
  assert.deepEqual(r('const a = process.env.A; const b = process.env?.B; const c = process.env[\'C\']; const d = process[\'env\'].D; const e = process?.env?.E;').names, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(r('const d = process[\'env\'].D;').occurrences, 1);
  assert.deepEqual(r('const num = (name: string) => Number(process.env[name]);\nexport const X = num(\'VITALS_EXTRA_PROBE\', 1);', 'num').names, ['VITALS_EXTRA_PROBE'],
    'a helper\'s literal argument is a pinned name');
  assert.ok(r('const num = (name: string) => Number(process.env[name]);').problems.some((p) => p.includes('outside a listed helper')));
  assert.ok(r('const num = (name: string) => Number(process.env[name]);\nconst k = \'X\';\nexport const X = num(k, 1);', 'num').problems.some((p) => p.includes('computed name')));
  assert.ok(r('import { env as e } from \'node:process\';\nexport const A = e.NEW1;').problems.some((p) => p.startsWith('imports process')));
  assert.ok(r('import proc from "process";').problems.some((p) => p.startsWith('imports process')));
  assert.ok(r('const { env: e2 } = process;\nexport const B = e2.NEW2;').problems.some((p) => p.startsWith('destructures process')));
  assert.ok(r('const p = process;\nexport const C = p.env.NEW3;').problems.some((p) => p.startsWith('aliases process')));
  assert.ok(r('const g = (globalThis as any)[\'process\'];').problems.some((p) => p.startsWith('indexes by the string process')));
  assert.equal(r('export const fn = () => resolve(process.env);').bare, 1, 'the whole environment passed on');
  assert.deepEqual(r('// process.on(\'exit\') aliases nothing (process\nconst x = process.pid;').problems, [], 'comments and other process members are not routes');
  assert.equal(('f(env: { [k: string]: string | undefined }); g(e: Partial<Record<string, string>>); h(x: typeof process.env)'.match(ENV_TYPE_RE) ?? []).length, 3);
});

test('★★★ v1.191.0 (review 3) — the names read through an environment parameter are pinned too (fixtures)', () => {
  // The parameter rule bounded how many such readers exist, not what they read: a new knob inside
  // resolveOutageAlertOptions(env) passed every gate.
  const r = (src: string) => readsOf(src);
  assert.deepEqual(r("export function f(env: Record<string, string | undefined>) { return env.A ?? env?.B ?? env['C']; }").names, ['A', 'B', 'C']);
  assert.deepEqual(r('export function g(opts: { env?: NodeJS.ProcessEnv }) { const e = opts.env ?? process.env; return e.D ?? opts.env?.E; }').names, ['D', 'E']);
  assert.deepEqual(r('export function h(env: NodeJS.ProcessEnv = process.env) { return env.TUI_X; }').names, ['TUI_X']);
  assert.deepEqual(r('export function k(src: { [k: string]: string | undefined }) { return src.K1; }').names, ['K1']);
  assert.deepEqual(envParamIdents('function g(opts: { env?: NodeJS.ProcessEnv }) { const e = opts.env ?? process.env; }'), ['e', 'env']);
  assert.ok(r('export function d(env: Record<string, string | undefined>, n: string) { return env[n]; }').problems.some((p) => p.includes('computed name')));
  assert.ok(r('export function d(env: Record<string, string | undefined>) { const { A } = env; return A; }').problems.some((p) => p.startsWith('destructures the environment parameter')));
  assert.deepEqual(r('const env = { a: 1 }; export const x = env.a;').names, [], 'an object that is not environment-typed is not a reader');
  // The three readers' names are in the manifest: a fourth name in any of them is a diff.
  const want = manifest();
  for (const [rel, names] of [
    ['alerts.ts', ['SYSTEM_OUTAGE_ALERT_ENABLED', 'SYSTEM_OUTAGE_MIN_MINUTES', 'SYSTEM_OUTAGE_RECENT_WINDOW_H', 'SYSTEM_OUTAGE_RESTART_MIN_MINUTES']],
    ['backupWindow.ts', ['BACKUP_WINDOW_LOG']],
    ['telnet/session.ts', ['TUI_PASSWORD', 'TUI_USERNAME']],
  ] as const) {
    for (const n of names) assert.ok(want[rel].names.includes(n), `${rel}: ${n} is pinned`);
    assert.deepEqual(readsOf(readFileSync(join(SRC, rel), 'utf8')).problems, [], `${rel}: read through its parameter by name only`);
  }
});

test('★ no module outside config.ts takes the environment as a parameter, beyond the three listed readers', () => {
  const offenders: string[] = [];
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs);
    if (rel === 'config.ts' || rel === PERMANENT_EXCEPTION) continue;
    const text = readFileSync(abs, 'utf8');
    const hits = (text.match(ENV_TYPE_RE) ?? []).length;
    const allowed = ENV_PARAM_ALLOWLIST[rel] ?? 0;
    if (hits > allowed) offenders.push(`${rel}: ${hits} environment-typed parameter(s), ${allowed} allowed`);
  }
  assert.deepEqual(offenders, []);
  for (const [rel, n] of Object.entries(ENV_PARAM_ALLOWLIST)) {
    const hits = (readFileSync(join(SRC, rel), 'utf8').match(ENV_TYPE_RE) ?? []).length;
    assert.equal(hits, n, `${rel}: the allowlist says ${n} but the file has ${hits} — shrink the allowlist when a reader moves`);
  }
});

test('config.ts is the only module that defines the option table', () => {
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs);
    if (rel === 'config.ts') continue;
    assert.ok(!/export const OPTIONS\b/.test(readFileSync(abs, 'utf8')), `${rel} defines a second OPTIONS table`);
  }
});

test('backupHook.mjs stays the one permanent exception, and reads only its own three variables', () => {
  const text = readFileSync(join(SRC, PERMANENT_EXCEPTION), 'utf8');
  const names = new Set([...text.matchAll(/process\.env\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  assert.deepEqual([...names].sort(), ['BACKUP_HOOK_TIMEOUT_MS', 'BACKUP_WINDOW_LOG', 'PORT']);
});
