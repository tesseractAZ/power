/**
 * Shared by tagRelease*.test.ts and releasePrCheck.test.ts: a small indentation-based reader for
 * the workflow files (no YAML dependency in the server), and a temporary origin + clones in which
 * tag-release.yml's tag step runs as the runner would run it.
 *
 * The tag step's script runs with `bash -e`: per run, a fresh clone with HEAD detached at the
 * run's commit and refs/remotes/origin/main forced to it (what actions/checkout does on a push),
 * and a stub `gh` first on PATH that logs its arguments, answers `release view` from a list and
 * can fail `workflow run`. Every environment is built from scratch, never from process.env: a CI
 * re-run sets GITHUB_RUN_ATTEMPT=2, and a developer's tag.gpgSign or hooks would leak in.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const wf = (name: string) => readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8');
export const CHECK_PY = resolve(ROOT, 'scripts/check-release-pr.py');

/* ── reading the workflows ─────────────────────────────────────────────────── */

/** A top-level key's block (its own line and every more-indented line after it). */
export function topBlock(yml: string, key: string): string {
  const lines = yml.split('\n');
  const at = lines.indexOf(`${key}:`);
  assert.ok(at >= 0, `no top-level ${key}:`);
  let end = at + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  return lines.slice(at, end).join('\n');
}

/** The lines of the step whose first line matches `head`, up to the next step or job. */
export function stepText(yml: string, head: RegExp): string {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => head.test(l));
  assert.ok(at >= 0, `step ${head} not found`);
  let end = at + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {0,4}\S/.test(lines[end])) end++;
  return lines.slice(at, end).join('\n');
}

/** A step's `run: |` block, de-indented, exactly as the runner writes it to disk. */
export function runBlock(step: string): string {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(at >= 0, 'no run: | block');
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n').replace(/\n+$/, '\n');
}


export const TAG_YML = wf('tag-release.yml');
export const TAG_STEP = stepText(TAG_YML, /^ {6}- name: Create tag and dispatch the image build$/);
export const TAG_SCRIPT = runBlock(TAG_STEP);

/* ── running the tag step ──────────────────────────────────────────────────── */

const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view") grep -qxF -- "$3" "$GH_RELEASES" ;;
  "workflow run") [ -z "\${GH_DISPATCH_FAILS:-}" ] ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 2 ;;
esac
`;

export const ZERO = '0'.repeat(40);

/**
 * git's own exec directory first on PATH: on macOS /usr/bin/git is an xcrun shim that costs ~10 ms
 * a call, and these scenarios make thousands. On Linux the directory holds the same git binary;
 * where it holds none, PATH falls through to the usual one.
 */
const GIT_CORE = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
export const TEST_PATH = [GIT_CORE, process.env.PATH ?? '/usr/bin:/bin'].filter(Boolean).join(':');

export interface RunOpts {
  sha: string;
  before?: string;
  /** The head commit message; null leaves HEAD_MSG unset. */
  msg?: string | null;
  event?: 'push' | 'workflow_dispatch';
  attempt?: string;
  /** Tags that have a GitHub Release. */
  releases?: string[];
  dispatchFails?: boolean;
}
export interface RunResult { status: number | null; out: string; gh: string[]; dispatched: string[] }

/** A temporary origin + developer clone; every git call runs with an isolated config. */
export class World {
  readonly dir = mkdtempSync(join(tmpdir(), 'ef-tag-release-'));
  readonly origin = join(this.dir, 'origin.git');
  readonly dev = join(this.dir, 'dev');
  readonly env: Record<string, string>;
  private n = 0;

  constructor() {
    const home = join(this.dir, 'home');
    const bin = join(this.dir, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), GH_STUB);
    chmodSync(join(bin, 'gh'), 0o755);
    const cfg = join(this.dir, 'gitconfig');
    writeFileSync(cfg, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n[advice]\n\tdetachedHead = false\n');
    this.env = { PATH: `${bin}:${TEST_PATH}`, HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
    this.git(this.dir, 'init', '-q', '--bare', '-b', 'main', this.origin);
    this.git(this.dir, 'init', '-q', '-b', 'main', this.dev);
    this.git(this.dev, 'remote', 'add', 'origin', this.origin);
  }

  git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, env: this.env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** Commits config.yaml (a version, `{ raw }` text, or null to delete it) and an unrelated file. */
  commit(cfg: string | { raw: string } | null, msg = 'change'): string {
    const path = join(this.dev, 'ecoflow_panel/config.yaml');
    mkdirSync(dirname(path), { recursive: true });
    if (cfg === null) { if (existsSync(path)) unlinkSync(path); }
    else writeFileSync(path, typeof cfg === 'string' ? `name: Power\nversion: "${cfg}"\nslug: ecoflow_panel\n` : cfg.raw);
    writeFileSync(join(this.dev, 'counter.txt'), `${++this.n}\n`);
    this.git(this.dev, 'add', '-A');
    this.git(this.dev, 'commit', '-q', '-m', msg);
    return this.git(this.dev, 'rev-parse', 'HEAD');
  }

  /** Pushes dev's main; returns the commit main pointed at before (the event's `before`). */
  push(): string {
    const r = spawnSync('git', ['--git-dir', this.origin, 'rev-parse', '-q', '--verify', 'refs/heads/main'], { env: this.env, encoding: 'utf8' });
    const before = r.status === 0 ? r.stdout.trim() : ZERO;
    this.git(this.dev, 'push', '-q', 'origin', 'main');
    return before;
  }

  /** A branch off `from` holding one commit, pushed (tags may point at it). */
  side(name: string, from: string, cfg: string): string {
    this.git(this.dev, 'checkout', '-q', '-b', name, from);
    const sha = this.commit(cfg, `side ${name}`);
    this.git(this.dev, 'push', '-q', 'origin', name);
    this.git(this.dev, 'checkout', '-q', 'main');
    return sha;
  }

  tag(name: string, sha: string): void {
    this.git(this.dir, '--git-dir', this.origin, 'tag', '-a', name, '-m', name, sha);
  }

  untag(name: string): void {
    this.git(this.dir, '--git-dir', this.origin, 'tag', '-d', name);
  }

  /** Origin's tags, each with the commit it points at. */
  tags(): Record<string, string> {
    const out = this.git(this.dir, '--git-dir', this.origin, 'for-each-ref', 'refs/tags', '--format=%(refname:short) %(*objectname)%(objectname)');
    const map: Record<string, string> = {};
    for (const l of out.split('\n').filter(Boolean)) {
      const [name, ids] = l.split(' ');
      map[name] = ids.slice(0, 40);
    }
    return map;
  }

  /** Rejects every tag push to origin (a protected-tag rule). */
  rejectTagPushes(): void {
    const hook = join(this.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "tag pushes are rejected" >&2; exit 1;; esac; done\nexit 0\n');
    chmodSync(hook, 0o755);
  }

  /** Runs the tag step as the runner would, for the event described by `o`. */
  run(o: RunOpts): RunResult {
    const k = ++this.n;
    const runner = join(this.dir, `runner-${k}`);
    this.git(this.dir, 'clone', '-q', this.origin, runner);
    this.git(runner, 'checkout', '-q', '--detach', o.sha);
    this.git(runner, 'update-ref', 'refs/remotes/origin/main', o.sha);
    const step = join(this.dir, `step-${k}.sh`);
    writeFileSync(step, TAG_SCRIPT);
    const log = join(this.dir, `gh-${k}.log`);
    const releases = join(this.dir, `releases-${k}`);
    writeFileSync(releases, (o.releases ?? []).map((r) => `${r}\n`).join(''));
    const env: Record<string, string> = {
      ...this.env, GH_TOKEN: 'test-token', GH_LOG: log, GH_RELEASES: releases,
      GITHUB_RUN_ATTEMPT: o.attempt ?? '1', EVENT_NAME: o.event ?? 'push', BEFORE: o.before ?? '',
    };
    if (o.msg !== null) env.HEAD_MSG = o.msg ?? '';
    if (o.dispatchFails) env.GH_DISPATCH_FAILS = '1';
    const r = spawnSync('bash', ['-e', step], { cwd: runner, env, encoding: 'utf8' });
    const gh = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { status: r.status, out: `${r.stdout}${r.stderr}`, gh, dispatched: gh.filter((l) => l.startsWith('workflow run ')) };
  }

  close(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

export function world(fn: (w: World) => void): void {
  const w = new World();
  try { fn(w); } finally { w.close(); }
}

/** main at 1.0.0, tagged and released: the state every scenario starts from. */
export function released100(w: World): string {
  const c1 = w.commit('1.0.0', 'Release v1.0.0 — first');
  w.push();
  w.tag('v1.0.0', c1);
  return c1;
}

export const dispatchOf = (v: string) => `workflow run images.yml -f version=${v}`;

