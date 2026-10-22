/**
 * mutateParallel.mjs — run a harness's mutants concurrently, each in its own copy of the tree.
 *
 * WHY. The harnesses ran one mutant at a time because each one edited the SHARED working tree
 * and restored it afterwards. Test files whose cases wait out real timers (the 8 s SIP timeout
 * probe, retry delays) made a single mutant cost one to two minutes, so a 99-mutant harness ran
 * for hours. Here every worker owns a private copy of the repository (node_modules symlinked),
 * so mutants run side by side and the real working tree is never written at all.
 *
 * VERDICT-PRESERVING. Each mutant gets exactly the old procedure, in its worker's copy: the
 * subset, and on a subset pass the full suite (whose unmutated baseline is checked once). Only
 * the scheduling changes. A harness keeps its anchors, subset and summary semantics.
 *
 * v1.191.0 (review) — A FULL-SUITE KILL IS CONFIRMED, NEVER TAKEN ON ONE RUN. At MUTATE_CONCURRENCY=4
 * the full-suite step ran four whole suites at once (~36 test processes on 10 cores): timing-sensitive
 * cases failed under that load and counted as kills, so an undeclared survivor was reported KILLED and
 * the harness exited 0 (four comment-only mutants read "4/4 killed" at concurrency 4 and "0/4" at 1).
 * Now: (1) at most one full suite runs at a time (other workers keep running their subsets); (2) it
 * runs with the spec reporter, so the failing tests are named; (3) a failure in a known teardown
 * flake (KNOWN_FLAKY_TEST_FILES) is never a kill signal; (4) the failing test files are re-run alone,
 * still one at a time, and the kill counts only if they fail again — a failure that does not
 * reproduce reports the mutant SURVIVED with the tests named, which the harness then shows (a false
 * survivor is visible; a false kill hid the gap). The unmutated full baseline is judged the same way.
 *
 * Concurrency: MUTATE_CONCURRENCY, else cores - 2 (at least 1). One per core (10 on a 10-core Mac)
 * made the timing-sensitive restart suites fail their all-workers baseline (v1187-3h/-4/-b, 2026-10-10);
 * cores - 2 passes them.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';

/** Resolve to true = the command exited 0, false = it ran and exited non-zero; reject if it could not run. */
function runOk(cmd, args, cwd) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (err) => {
      if (!err) return res(true);
      if (typeof err.code === 'number' && err.signal == null) return res(false);
      rej(err);
    });
  });
}

function makeWorkerTree(root) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-worker-'));
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'web/dist', `${root}/`, `${dir}/`]);
  for (const nm of ['server/node_modules', 'web/node_modules']) {
    if (existsSync(join(root, nm))) symlinkSync(join(root, nm), join(dir, nm));
  }
  return dir;
}

/** Like runOk, but also returns the combined output (for naming the failing tests). */
function runCapture(cmd, args, cwd) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (!err) return res({ ok: true, out });
      if (typeof err.code === 'number' && err.signal == null) return res({ ok: false, out });
      rej(err);
    });
  });
}

/** Test files whose failures are known teardown flakes (ENOTEMPTY on a shared cache directory, a
 *  timing-sensitive all-clear): a failure there is never a kill signal in the full-suite step. A
 *  harness that wants them as a kill lists them in its subset. */
export const KNOWN_FLAKY_TEST_FILES = Object.freeze([
  'test/conditionRetryWords.test.ts',
  'test/stormGateRepeatAndAllClear.test.ts',
  'test/restartRecoverySettledSet.test.ts',
]);

/** The failing tests in a spec-reporter summary, each with the file the reporter names. PURE. */
export function failingTestsWithFiles(out) {
  const at = out.lastIndexOf('failing tests:');
  if (at < 0) return [];
  const res = [];
  const seen = new Set();
  let file = null;
  for (const raw of out.slice(at).split('\n')) {
    const line = raw.trim();
    const loc = /^test at (.+?):\d+:\d+$/.exec(line);
    if (loc) { file = loc[1]; continue; }
    const m = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (m && m[1] !== 'failing tests:' && file != null) {
      const key = `${file}\u0000${m[1]}`;
      if (!seen.has(key)) { seen.add(key); res.push({ file, name: m[1] }); }
      file = null;
    }
  }
  return res;
}

/**
 * The verdict of the full-suite step from its run(s); the re-runs are injected (no I/O of its own). `first` is the full suite's result;
 * `confirm` re-runs the named files alone (and `rerunFull` the whole suite once when the first run
 * named no test). Returns { killed, by, note }: killed only when the failure reproduces outside the
 * known flakes.
 */
export async function fullSuiteVerdict(first, { confirm, rerunFull, flaky = KNOWN_FLAKY_TEST_FILES }) {
  if (first.ok) return { killed: false, by: [], note: null };
  const failed = failingTestsWithFiles(first.out);
  const real = failed.filter((f) => !flaky.includes(f.file));
  if (failed.length > 0 && real.length === 0) {
    return { killed: false, by: [], note: `the full suite failed only in known flakes (${failed.map((f) => `${f.file}: ${f.name}`).join('; ')}) — not a kill` };
  }
  if (failed.length === 0) {
    const again = await rerunFull();
    if (again.ok) return { killed: false, by: [], note: 'the full suite failed once, named no test, and passed when re-run — not a kill' };
    const named = failingTestsWithFiles(again.out).filter((f) => !flaky.includes(f.file));
    if (named.length === 0 && failingTestsWithFiles(again.out).length > 0) {
      return { killed: false, by: [], note: 'the re-run failed only in known flakes — not a kill' };
    }
    return { killed: true, by: named.length ? named.map((f) => `${f.name} (${f.file})`) : ['(the full suite failed twice; no test named)'], note: null };
  }
  const files = [...new Set(real.map((f) => f.file))];
  const conf = await confirm(files);
  const still = conf.ok ? [] : failingTestsWithFiles(conf.out).filter((f) => !flaky.includes(f.file));
  if (!conf.ok && (still.length > 0 || failingTestsWithFiles(conf.out).length === 0)) {
    return { killed: true, by: (still.length ? still : real).map((f) => `${f.name} (${f.file})`), note: null };
  }
  return { killed: false, by: [], note: `the full-suite failure did not reproduce in its own file(s): ${real.map((f) => `${f.name} (${f.file})`).join('; ')} — not a kill` };
}

/** The failing test names from the spec reporter's summary (deduplicated). */
function failingTests(out) {
  const at = out.lastIndexOf('failing tests:');
  const names = new Set();
  for (const line of (at >= 0 ? out.slice(at) : out).split('\n')) {
    const m = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (m && m[1] !== 'failing tests:') names.add(m[1]);
  }
  return [...names];
}

/**
 * @param {object} o
 * @param {string} o.name         harness name for the header
 * @param {Array<{id:string,file:string,find:string,to:string,why:string,tests?:string[]}>} o.mutants
 * @param {string[]} [o.subset]   test files relative to server/ (the default procedure)
 * @param {string} o.root         repository root (absolute)
 * @param {boolean} [o.perMutantTests]  each mutant runs only its own `tests` (no full-suite step);
 *                                the failing tests are named; `fullSuite` still applies on a pass.
 * @param {boolean} [o.typecheck] a mutant must typecheck (tsc -p tsconfig.test.json) or it is INVALID
 *                                (reported, never counted, exit 1).
 * @param {(m: object) => boolean} [o.knownSurvivor]  a survivor this matches is declared, not a failure.
 * @param {boolean} [o.fullSuite] false = the subset alone decides (no full-suite step), for harnesses built that way.
 * @param {number} [o.concurrency] a cap on the default worker count for a suite that is timing-sensitive
 *                                under load (its all-workers baseline fails); MUTATE_CONCURRENCY still wins.
 * Argv `--only <id-prefix>` selects mutants (anchors are still checked for all of them).
 * @returns {Promise<never>}      exits the process with the harness's usual codes (0 / 1 / 2)
 */
export async function runMutantsParallel({ name, mutants, subset = [], root, perMutantTests = false, typecheck = false, knownSurvivor = null, fullSuite = true, concurrency = null }) {
  root = resolve(root);
  const originals = new Map();
  for (const m of mutants) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
  for (const [f, s] of originals) {
    if (s.includes('/* MUTANT')) { console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`); process.exit(2); }
  }
  for (const m of mutants) {
    const hits = originals.get(m.file).split(m.find).length - 1;
    if (hits !== 1) { console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`); process.exit(2); }
    if (perMutantTests && !(Array.isArray(m.tests) && m.tests.length)) { console.error(`\nABORT: "${m.id}" names no tests.`); process.exit(2); }
  }
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
  const selected = only ? mutants.filter((m) => m.id.startsWith(only)) : mutants;
  if (only && selected.length === 0) { console.error(`\nABORT: --only ${only} selects no mutant.`); process.exit(2); }

  const want = Number(process.env.MUTATE_CONCURRENCY);
  const n = Math.max(1, Math.min(selected.length, Number.isFinite(want) && want > 0 ? want : Math.max(1, Math.min(concurrency ?? Infinity, availableParallelism() - 2))));
  const workers = Array.from({ length: n }, () => makeWorkerTree(root));
  const cleanup = () => { for (const w of workers) rmSync(w, { recursive: true, force: true }); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); console.error(`\ninterrupted (${sig}) — worker copies removed; the real tree was never written`); process.exit(130); });

  const testArgs = (files) => ['--import', 'tsx', '--test', ...(perMutantTests ? ['--test-reporter=spec'] : []), ...files];
  const baseFiles = perMutantTests ? [...new Set(selected.flatMap((m) => m.tests))] : subset;
  const tsc = (dir) => runOk(join(dir, 'server', 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', 'tsconfig.test.json'], join(dir, 'server'));
  try {
    if (typecheck && !(await tsc(workers[0]))) {
      console.error('\nABORT: the UNMUTATED tree does not typecheck.'); cleanup(); process.exit(2);
    }
    // The baseline runs in EVERY worker at once, under the same load the mutants will see: a
    // timing-sensitive case that fails under load would otherwise count a mutant as killed and
    // hide a survivor. Any failure aborts (lower MUTATE_CONCURRENCY, or fix the flaky case).
    const base = await Promise.all(workers.map((w) => runOk('node', testArgs(baseFiles), join(w, 'server'))));
    if (base.some((ok) => !ok)) {
      console.error(`\nABORT: the ${perMutantTests ? 'named tests fail' : 'subset fails'} on the UNMUTATED tree in ${base.filter((ok) => !ok).length}/${n} parallel worker(s). ${n > 1 ? 'Under parallel load it is not a reliable kill signal — lower MUTATE_CONCURRENCY or fix the flaky case.' : 'Fix the baseline first.'}`);
      cleanup(); process.exit(2);
    }
    console.log(`${name}: ${selected.length} mutants against ${perMutantTests ? 'their named tests' : subset.join(' + ')} — ${n} parallel worker(s)\n`);

    // v1.191.0 (review) — one full suite at a time, with the spec reporter (the failing tests named).
    let fullLock = Promise.resolve();
    const serialFull = (fn) => { const run = fullLock.then(fn, fn); fullLock = run.then(() => {}, () => {}); return run; };
    const FULL_ARGS = ['--import', 'tsx', '--test', '--test-reporter=spec', 'test/**/*.test.ts'];
    const runFull = (dir) => serialFull(() => runCapture('node', FULL_ARGS, join(dir, 'server')));
    const runFiles = (dir, files) => serialFull(() => runCapture('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...files], join(dir, 'server')));

    let fullBaseline = null; // Promise<boolean>, checked once, in its own copy
    const fullBaselineOk = () => {
      if (!fullBaseline) {
        const dir = makeWorkerTree(root);
        // The unmutated suite is judged like a mutant: a failure only in a known flake, or one that does
        // not reproduce in its own file, does not stop the harness.
        fullBaseline = runFull(dir)
          .then((first) => fullSuiteVerdict(first, { confirm: (files) => runFiles(dir, files), rerunFull: () => runFull(dir) }))
          .then((v) => {
            if (v.note) console.log(`  (unmutated full suite: ${v.note})`);
            if (v.killed) console.error(`  unmutated full suite fails: ${v.by.join('; ')}`);
            return !v.killed;
          })
          .finally(() => rmSync(dir, { recursive: true, force: true }));
      }
      return fullBaseline;
    };

    const verdicts = new Array(selected.length); // true killed, false survived, 'invalid'
    let next = 0;
    const t0 = Date.now();
    await Promise.all(workers.map(async (w) => {
      while (next < selected.length) {
        const i = next++;
        const m = selected[i];
        const target = join(w, relative(root, m.file));
        const original = originals.get(m.file);
        writeFileSync(target, original.replace(m.find, m.to));
        try {
          if (typecheck && !(await tsc(w))) {
            verdicts[i] = 'invalid';
            console.log(`  INVALID  ${m.id}\n           ↳ the mutant does not typecheck — fix the mutant`);
            continue;
          }
          let died;
          let by = [];
          let note = null;
          if (perMutantTests) {
            const r = await runCapture('node', testArgs(m.tests), join(w, 'server'));
            died = !r.ok;
            if (died) by = failingTests(r.out);
          } else {
            died = !(await runOk('node', testArgs(subset), join(w, 'server')));
          }
          {
            if (!died && fullSuite) {
              if (!(await fullBaselineOk())) {
                console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.'); cleanup(); process.exit(2);
              }
              const v = await fullSuiteVerdict(await runFull(w), { confirm: (files) => runFiles(w, files), rerunFull: () => runFull(w) });
              died = v.killed;
              by = v.by;
              note = v.note;
            }
          }
          verdicts[i] = died;
          console.log(`  ${died ? 'KILLED  ' : 'SURVIVED'} ${m.id}${died ? '' : `\n           ↳ ${m.why}`}`);
          if (note) console.log(`           ↳ ${note}`);
          for (const t of by.slice(0, 4)) console.log(`           ✖ ${t}`);
          if (by.length > 4) console.log(`           … and ${by.length - 4} more`);
        } finally {
          writeFileSync(target, original);
        }
      }
    }));

    const killed = verdicts.filter((v) => v === true).length;
    const invalid = selected.filter((_, i) => verdicts[i] === 'invalid');
    const survivors = selected.filter((_, i) => verdicts[i] === false);
    const undeclared = knownSurvivor ? survivors.filter((s) => !knownSurvivor(s)) : survivors;
    console.log(`\n${killed}/${selected.length} mutants killed (${Math.round((Date.now() - t0) / 1000)} s, ${n} worker(s))`);
    if (invalid.length) {
      console.log('\nINVALID — these mutants do not typecheck and were not run:');
      for (const s of invalid) console.log(`  - ${s.id}`);
    }
    if (survivors.length) {
      console.log(knownSurvivor ? '\nSURVIVORS:' : '\nSURVIVORS — the suite does not constrain these behaviours:');
      for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
    }
    if (invalid.length || undeclared.length) {
      if (knownSurvivor && undeclared.length) console.error(`\n${undeclared.length} UNDECLARED survivor(s) — fix or declare them.`);
      cleanup(); process.exit(1);
    }
    if (survivors.length) console.log('\nAll survivors are declared in the harness with their reason. Exit 0.');
    console.log('post-run: the real tree was never written');
    cleanup(); process.exit(0);
  } catch (e) {
    cleanup(); throw e;
  }
}
