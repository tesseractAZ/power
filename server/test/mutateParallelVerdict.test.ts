import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * v1.191.0 (review) — the mutation runner's full-suite step confirms a kill before counting it
 * (scripts/lib/mutateParallel.mjs). At MUTATE_CONCURRENCY=4 four whole suites ran at once; the
 * timing-sensitive cases that failed under that load, and the known teardown flakes, counted as kills,
 * so an undeclared survivor read KILLED and the harness exited 0. A full-suite failure now counts only
 * when it is outside the known flakes and reproduces when its own files run alone; the suites run one
 * at a time, with the failing tests named.
 */

const ROOT = resolve(import.meta.dirname, '../..');
interface Run { ok: boolean; out: string }
interface Verdict { killed: boolean; by: string[]; note: string | null }
const lib = (await import(pathToFileURL(resolve(ROOT, 'scripts/lib/mutateParallel.mjs')).href)) as {
  KNOWN_FLAKY_TEST_FILES: readonly string[];
  failingTestsWithFiles(out: string): Array<{ file: string; name: string }>;
  fullSuiteVerdict(first: Run, o: { confirm(files: string[]): Promise<Run>; rerunFull(): Promise<Run>; flaky?: readonly string[] }): Promise<Verdict>;
};

/** A spec-reporter summary naming these failures. */
const summary = (fails: Array<[string, string]>): string => [
  'ℹ tests 5494', `ℹ fail ${fails.length}`, '', '✖ failing tests:', '',
  ...fails.flatMap(([file, name]) => [`test at ${file}:1:2345`, `✖ ${name} (12.5ms)`, '  AssertionError [ERR_ASSERTION]: x', '']),
].join('\n');
const PASS: Run = { ok: true, out: 'ℹ fail 0' };
const failRun = (fails: Array<[string, string]>): Run => ({ ok: false, out: summary(fails) });
const never = async (): Promise<Run> => { throw new Error('not expected to run'); };

test('failingTestsWithFiles reads each failing test with its file, once', () => {
  const out = `noise ✖ not a summary line\n${summary([['test/a.test.ts', 'one (with parens)'], ['test/b.test.ts', 'two'], ['test/a.test.ts', 'one (with parens)']])}`;
  assert.deepEqual(lib.failingTestsWithFiles(out), [
    { file: 'test/a.test.ts', name: 'one (with parens)' },
    { file: 'test/b.test.ts', name: 'two' },
  ]);
  assert.deepEqual(lib.failingTestsWithFiles('ℹ fail 0'), []);
});

test('★★★ a failure only in a known teardown flake is never a kill (the review saw refusedRetryRepresent kill TA01, WL2, WL3, WL8)', async () => {
  assert.ok(lib.KNOWN_FLAKY_TEST_FILES.includes('test/conditionRetryWords.test.ts'));
  const v = await lib.fullSuiteVerdict(failRun([['test/conditionRetryWords.test.ts', 'refusedRetryRepresent']]), { confirm: never, rerunFull: never });
  assert.equal(v.killed, false);
  assert.match(v.note!, /only in known flakes/);
});

test('★★★ a failure that does not reproduce in its own file is not a kill (the load-induced false kills)', async () => {
  const asked: string[][] = [];
  const v = await lib.fullSuiteVerdict(failRun([['test/backupHook.test.ts', 'main-thread stall pre'], ['test/conditionRetryWords.test.ts', 'refusedRetryRepresent']]), {
    confirm: async (files) => { asked.push(files); return PASS; }, rerunFull: never,
  });
  assert.deepEqual(asked, [['test/backupHook.test.ts']], 'only the non-flaky file is re-run');
  assert.equal(v.killed, false);
  assert.match(v.note!, /did not reproduce .*main-thread stall pre \(test\/backupHook\.test\.ts\)/);
});

test('★★★ a failure that reproduces is a kill, and names the test', async () => {
  const v = await lib.fullSuiteVerdict(failRun([['test/tariffPlan.test.ts', 'the model is deep-equal']]), {
    confirm: async () => failRun([['test/tariffPlan.test.ts', 'the model is deep-equal']]), rerunFull: never,
  });
  assert.deepEqual(v, { killed: true, by: ['the model is deep-equal (test/tariffPlan.test.ts)'], note: null });
});

test('★★ a confirmation that fails only in a flake is not a kill; one that crashes without names is', async () => {
  const flakyAgain = await lib.fullSuiteVerdict(failRun([['test/x.test.ts', 'x']]), {
    confirm: async () => failRun([['test/stormGateRepeatAndAllClear.test.ts', 'held all-clear']]), rerunFull: never,
  });
  assert.equal(flakyAgain.killed, false);
  const crashed = await lib.fullSuiteVerdict(failRun([['test/x.test.ts', 'x']]), { confirm: async () => ({ ok: false, out: 'SyntaxError' }), rerunFull: never });
  assert.deepEqual(crashed, { killed: true, by: ['x (test/x.test.ts)'], note: null });
});

test('★★ a failed full suite that names no test is re-run once: a kill only if it fails again', async () => {
  const unnamed: Run = { ok: false, out: 'Error: worker exited' };
  assert.equal((await lib.fullSuiteVerdict(unnamed, { confirm: never, rerunFull: async () => PASS })).killed, false);
  const twice = await lib.fullSuiteVerdict(unnamed, { confirm: never, rerunFull: async () => unnamed });
  assert.deepEqual(twice, { killed: true, by: ['(the full suite failed twice; no test named)'], note: null });
  const named = await lib.fullSuiteVerdict(unnamed, { confirm: never, rerunFull: async () => failRun([['test/y.test.ts', 'y']]) });
  assert.deepEqual(named.by, ['y (test/y.test.ts)']);
});

test('a passing full suite is a survivor with nothing re-run', async () => {
  assert.deepEqual(await lib.fullSuiteVerdict(PASS, { confirm: never, rerunFull: never }), { killed: false, by: [], note: null });
});

test('★★ wiring: the full-suite step runs one suite at a time, with the spec reporter, through the verdict', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/lib/mutateParallel.mjs'), 'utf8');
  assert.ok(src.includes("const FULL_ARGS = ['--import', 'tsx', '--test', '--test-reporter=spec', 'test/**/*.test.ts'];"));
  assert.ok(src.includes('const runFull = (dir) => serialFull(() => runCapture(\'node\', FULL_ARGS, join(dir, \'server\')));'));
  assert.ok(src.includes('const v = await fullSuiteVerdict(await runFull(w), { confirm: (files) => runFiles(w, files), rerunFull: () => runFull(w) });'));
  assert.ok(!src.includes("runOk('npm', ['test', '--silent']"), 'no full suite counted on one unnamed run');
  // The package's own test script is the same glob the runner passes.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'server/package.json'), 'utf8')) as { scripts: { test: string } };
  assert.equal(pkg.scripts.test, 'node --import tsx --test "test/**/*.test.ts"');
});
