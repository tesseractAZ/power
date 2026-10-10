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
 * Concurrency: MUTATE_CONCURRENCY, else one worker per core (most cases wait on timers, so a full
 * machine adds throughput; the all-workers baseline above guards against load flakes), at least 1.
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

/**
 * @param {object} o
 * @param {string} o.name         harness name for the header
 * @param {Array<{id:string,file:string,find:string,to:string,why:string}>} o.mutants
 * @param {string[]} o.subset     test files relative to server/
 * @param {string} o.root         repository root (absolute)
 * @returns {Promise<never>}      exits the process with the harness's usual codes (0 / 1 / 2)
 */
export async function runMutantsParallel({ name, mutants, subset, root }) {
  root = resolve(root);
  const originals = new Map();
  for (const m of mutants) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
  for (const [f, s] of originals) {
    if (s.includes('/* MUTANT')) { console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`); process.exit(2); }
  }
  for (const m of mutants) {
    const hits = originals.get(m.file).split(m.find).length - 1;
    if (hits !== 1) { console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`); process.exit(2); }
  }

  const want = Number(process.env.MUTATE_CONCURRENCY);
  const n = Math.max(1, Math.min(mutants.length, Number.isFinite(want) && want > 0 ? want : availableParallelism()));
  const workers = Array.from({ length: n }, () => makeWorkerTree(root));
  const cleanup = () => { for (const w of workers) rmSync(w, { recursive: true, force: true }); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); console.error(`\ninterrupted (${sig}) — worker copies removed; the real tree was never written`); process.exit(130); });

  const subsetArgs = ['--import', 'tsx', '--test', ...subset];
  try {
    // The baseline runs in EVERY worker at once, under the same load the mutants will see: a
    // timing-sensitive case that fails under load would otherwise count a mutant as killed and
    // hide a survivor. Any failure aborts (lower MUTATE_CONCURRENCY, or fix the flaky case).
    const base = await Promise.all(workers.map((w) => runOk('node', subsetArgs, join(w, 'server'))));
    if (base.some((ok) => !ok)) {
      console.error(`\nABORT: the subset fails on the UNMUTATED tree in ${base.filter((ok) => !ok).length}/${n} parallel worker(s). ${n > 1 ? 'Under parallel load it is not a reliable kill signal — lower MUTATE_CONCURRENCY or fix the flaky case.' : 'Fix the baseline first.'}`);
      cleanup(); process.exit(2);
    }
    console.log(`${name}: ${mutants.length} mutants against ${subset.join(' + ')} — ${n} parallel worker(s)\n`);

    let fullBaseline = null; // Promise<boolean>, checked once, in its own copy
    const fullBaselineOk = () => {
      if (!fullBaseline) {
        const dir = makeWorkerTree(root);
        fullBaseline = runOk('npm', ['test', '--silent'], join(dir, 'server')).finally(() => rmSync(dir, { recursive: true, force: true }));
      }
      return fullBaseline;
    };

    const verdicts = new Array(mutants.length);
    let next = 0;
    const t0 = Date.now();
    await Promise.all(workers.map(async (w) => {
      while (next < mutants.length) {
        const i = next++;
        const m = mutants[i];
        const target = join(w, relative(root, m.file));
        const original = originals.get(m.file);
        writeFileSync(target, original.replace(m.find, m.to));
        try {
          let died = !(await runOk('node', subsetArgs, join(w, 'server')));
          if (!died) {
            if (!(await fullBaselineOk())) {
              console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.'); cleanup(); process.exit(2);
            }
            died = !(await runOk('npm', ['test', '--silent'], join(w, 'server')));
          }
          verdicts[i] = died;
          console.log(`  ${died ? 'KILLED  ' : 'SURVIVED'} ${m.id}${died ? '' : `\n           ↳ ${m.why}`}`);
        } finally {
          writeFileSync(target, original);
        }
      }
    }));

    const killed = verdicts.filter(Boolean).length;
    const survivors = mutants.filter((_, i) => !verdicts[i]);
    console.log(`\n${killed}/${mutants.length} mutants killed (${Math.round((Date.now() - t0) / 1000)} s, ${n} worker(s))`);
    if (survivors.length) {
      console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
      for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
      cleanup(); process.exit(1);
    }
    console.log('post-run: the real tree was never written');
    cleanup(); process.exit(0);
  } catch (e) {
    cleanup(); throw e;
  }
}
