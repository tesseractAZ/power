import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * v1.193.0 — `scripts/check-no-secrets.py --stdin` applies the scan's shape rules (and the owner's
 * private value rules, where configured) to text on standard input. The tree scan reads text files
 * only and skips an image, so the README screenshot tool (scripts/screenshots/capture.mts) pipes the
 * text of every page it photographs through this mode. CI's run, with no flag, must not change.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts', 'check-no-secrets.py');
/** A clean environment: no CHECK_NO_SECRETS_PRIVATE_PATTERNS from the machine running the suite. */
const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() };
/**
 * The script run from a copy in an empty directory. With the variable unset it falls back to a
 * .no-secrets-private.json beside the repository root, which a maintainer checkout may hold: run
 * from the tree, these tests would load that file's rules (or stop on its permissions).
 */
const ISOLATED = mkdtempSync(join(tmpdir(), 'nosecrets-stdin-'));
mkdirSync(join(ISOLATED, 'scripts'));
const ISOLATED_SCRIPT = join(ISOLATED, 'scripts', 'check-no-secrets.py');
copyFileSync(SCRIPT, ISOLATED_SCRIPT);
after(() => rmSync(ISOLATED, { recursive: true, force: true }));

function stdin(text: string, env: Record<string, string> = ENV, script = ISOLATED_SCRIPT): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', ['-I', '-B', script, '--stdin'], { input: text, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Split so this file holds no serial-shaped token of its own (check-no-secrets.py scans it).
const REAL = 'Y711ABC12' + 'DEF3456';

test('a non-placeholder serial on stdin fails, named by its public model code only', () => {
  const r = stdin(`line one\nid=${REAL};\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /<stdin>:2: serial-shaped token \(model code Y711\)/);
  assert.ok(!r.stderr.includes('ABC12DEF3456') && !r.stdout.includes('ABC12DEF3456'), 'the token must not be echoed');
});

test('placeholders, the example subnet and the fictional phone range pass', () => {
  const r = stdin('COREXXX00XXX0001 192.168.1.20 602-555-0142\nCore 1 · Pack 2 · 2026-06-17 12:30 PM\n');
  assert.equal(r.status, 0, r.stderr);
  // No private rule loaded: the run does not depend on the machine's own pattern file.
  assert.match(r.stdout, /OK — standard input clean; shape rules only/);
});

test('every shape rule applies on stdin: a home subnet, an email, a phone number', () => {
  const lan = stdin('gw ' + '192.168.' + '7.20');
  assert.equal(lan.status, 1);
  assert.match(lan.stderr, /<stdin>:1:4: a private LAN address outside the example subnets/);
  assert.equal(stdin('mail ' + 'jane.doe' + '@' + 'mailhost.co').status, 1);
  assert.equal(stdin('tel ' + ['602', '555', '0287'].join('-')).status, 1);
});

test('the private value rules apply on stdin, labelled, never echoed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nosecrets-'));
  try {
    const file = join(dir, 'private.json');
    writeFileSync(file, JSON.stringify([{ why: 'probe value', re: 'zebra-\\d{3}', probe: 'zebra-123' }]));
    chmodSync(file, 0o600);
    const r = stdin('ok text\nnear zebra-907 here\n', { ...ENV, CHECK_NO_SECRETS_PRIVATE_PATTERNS: file });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /<stdin>:2: private pattern \(probe value\)/);
    assert.ok(!r.stderr.includes('zebra-907'));
    const clean = stdin('nothing to see\n', { ...ENV, CHECK_NO_SECRETS_PRIVATE_PATTERNS: file });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /1 private value pattern\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no flag the script still scans the tracked tree and ignores stdin (CI unchanged)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nosecrets-tree-'));
  try {
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(SCRIPT, join(dir, 'scripts', 'check-no-secrets.py'));
    // The three runtime files the scan pins to an exact serial count (SERIAL_EXEMPT_COUNTS).
    put('server/device-aliases.json', `{"${REAL}": "x"}\n`);
    put('server/src/index.ts', `const a = '${REAL}';\n`);
    put('server/src/shp2Membership.ts', `const a = '${REAL}';\nconst b = '${REAL}';\n`);
    put('README.md', 'A clean tree.\n');
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', 'scripts', 'server', 'README.md').status, 0);
    const scan = () => spawnSync('python3', ['-I', '-B', join(dir, 'scripts', 'check-no-secrets.py')], { input: `id=${REAL}\n`, encoding: 'utf8', env: ENV });
    const clean = scan();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /OK — 5 tracked text files clean \(4 serial-shaped token\(s\) pinned in 3 file\(s\)/);
    put('notes/leak.txt', `unit ${REAL}\n`);
    assert.equal(git('add', 'notes/leak.txt').status, 0);
    const leak = scan();
    assert.equal(leak.status, 1);
    assert.match(leak.stderr, /notes\/leak\.txt:1: serial-shaped token \(model code Y711\)/);
    assert.doesNotMatch(leak.stderr, /<stdin>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
