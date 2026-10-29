/**
 * The SSH console's options and its options→env contract.
 *
 * `SSH_ENABLED` / `SSH_PORT` are the console's options. v1.191.6 removed the deprecated
 * `TELNET_ENABLED` / `TELNET_PORT` / `TELNET_HOST` aliases (telnet has not been served
 * since v1.190.0): nothing reads, exports, declares or describes them.
 *
 *   1. resolveSshConfig reads SSH_* only; a stale TELNET_* value changes nothing.
 *   2. The run script exports SSH_ENABLED 1/0, SSH_PORT and the fixed host and host-key
 *      path, and no TELNET_* variable; config.ts and index.ts carry no alias code.
 *   3. config.yaml publishes the port SSH_PORT defaults to and declares no TELNET_* option;
 *      no translations file names one.
 *   4. Options ⇄ translations parity: every options key has a name and a
 *      description in every translations file and no file names a key that is
 *      gone (scripts/validate-addon-config.py's rule, applied here too, and the
 *      script itself run when PyYAML is available).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveSshConfig, SSH_DEFAULT_PORT } from '../src/config.js';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const CONFIG = read('ecoflow_panel/config.yaml');
const RUN = read('rootfs/etc/services.d/ecoflow-panel/run');

/* ── 1. the resolver ───────────────────────────────────────────────────── */

test('ssh config — SSH_ENABLED decides on its own; a bare env stays on', () => {
  assert.equal(resolveSshConfig({ SSH_ENABLED: '1' }).enabled, true);
  assert.equal(resolveSshConfig({ SSH_ENABLED: '0' }).enabled, false);
  // Dev / tests with nothing exported: on (the run script always exports 1 or 0).
  const bare = resolveSshConfig({});
  assert.equal(bare.enabled, true);
  assert.equal(bare.port, SSH_DEFAULT_PORT);
  assert.equal(bare.host, '::');
  assert.equal(bare.hostKeyPath, '/data/ssh_host_ed25519_key');
  assert.deepEqual(Object.keys(bare).sort(), ['enabled', 'host', 'hostKeyPath', 'port'], 'no alias plumbing left on the value');
});

test('ssh config — a stale TELNET_* value changes nothing (v1.191.6)', () => {
  const ssh = { SSH_ENABLED: '0', SSH_PORT: '2323', SSH_HOST: '::', SSH_HOST_KEY: '/data/ssh_host_ed25519_key' };
  const withStale = { ...ssh, TELNET_ENABLED: '1', TELNET_PORT: '2400', TELNET_HOST: '0.0.0.0' };
  assert.deepEqual(resolveSshConfig(withStale), resolveSshConfig(ssh));
  assert.equal(resolveSshConfig(withStale).enabled, false, 'TELNET_ENABLED no longer turns the console on');
  assert.equal(resolveSshConfig({ SSH_PORT: '2323', TELNET_PORT: '2400' }).port, 2323, 'TELNET_PORT no longer moves it');
  assert.equal(resolveSshConfig({ TELNET_HOST: '0.0.0.0' }).host, '::', 'TELNET_HOST no longer binds it');
});

test('ssh config — port, host and host-key path come from SSH_PORT / SSH_HOST / SSH_HOST_KEY', () => {
  assert.equal(resolveSshConfig({ SSH_PORT: '2400' }).port, 2400);
  assert.equal(resolveSshConfig({ SSH_HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(resolveSshConfig({ SSH_HOST_KEY: '/tmp/k' }).hostKeyPath, '/tmp/k');
});

/* ── 2. the options→env bridge ─────────────────────────────────────────── */

test('ssh config — the run script exports SSH_ENABLED 1/0, SSH_PORT and the fixed host and key path, and no TELNET_* variable', () => {
  const block = RUN.slice(RUN.indexOf("bashio::config.true 'SSH_ENABLED'"));
  const body = block.slice(0, block.indexOf('\nfi'));
  assert.match(body, /export SSH_ENABLED=1/);
  assert.match(body, /export SSH_ENABLED=0/);
  assert.ok(!/SSH_ENABLED=(true|false)/.test(body), 'config.ts reads `!== \'0\'`; the string false would read as on');
  assert.match(RUN, /^export SSH_HOST=::$/m);
  assert.match(RUN, /^export SSH_PORT="\$\(bashio::config 'SSH_PORT'\)"$/m);
  assert.match(RUN, /^export SSH_HOST_KEY=\/data\/ssh_host_ed25519_key$/m, 'the key path is a literal, as config.ts and the AppArmor /data rule expect');
  assert.doesNotMatch(RUN, /^[^#]*TELNET_/m, 'no TELNET_* option is read or exported');
  // config.ts reads the exported names, and nothing else.
  const cfg = read('server/src/config.ts');
  assert.match(cfg, /env\.SSH_PORT \?\? SSH_DEFAULT_PORT/);
  assert.match(cfg, /env\.SSH_ENABLED !== '0'/);
  assert.match(cfg, /env\.SSH_HOST_KEY \?\? '\/data\/ssh_host_ed25519_key'/);
  assert.doesNotMatch(cfg, /env\.TELNET_|name: 'TELNET_/, 'no alias is read or declared');
});

test('ssh config — the call site puts the host key fingerprint on the startup line; no alias notice remains', () => {
  const idx = read('server/src/index.ts');
  assert.match(idx, /loadOrCreateHostKey\(config\.ssh\.hostKeyPath,/, 'the host key comes from the configured path');
  assert.match(idx, /\$\{describeSshAuth\(authFromEnv\(\)\)\} — host key \$\{hostKey\.fingerprint\}`\)/, 'the fingerprint is on the startup line at every start');
  assert.doesNotMatch(idx, /startTelnetServer|config\.telnet\b|deprecationNotes|TELNET_/);
  assert.match(idx, /from '\.\/console\/server\.js'/, 'the console lives in src/console');
});

/* ── 3. the manifest ───────────────────────────────────────────────────── */

function section(name: 'options' | 'schema'): Map<string, string> {
  const i = CONFIG.indexOf(`\n${name}:`);
  assert.notEqual(i, -1, `config.yaml must have a ${name} block`);
  const out = new Map<string, string>();
  for (const line of CONFIG.slice(i + 1).split('\n').slice(1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^  ([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
  }
  return out;
}

/** The `name:` / `description:` lines under one `  KEY:` entry of a translations file. */
function entryOf(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const at = lines.indexOf(`  ${key}:`);
  if (at === -1) return '';
  const out: string[] = [];
  for (let i = at + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
}

test('ssh config — config.yaml publishes the port SSH_PORT defaults to, declares no TELNET_* option, and says SSH', () => {
  const options = section('options');
  const schema = section('schema');
  assert.equal(options.get('SSH_ENABLED'), 'false', 'off by default (CWE-1188)');
  assert.equal(Number(options.get('SSH_PORT')), SSH_DEFAULT_PORT);
  assert.equal(schema.get('SSH_ENABLED'), 'bool');
  assert.equal(schema.get('SSH_PORT'), 'port');
  // v1.191.6 — the deprecated aliases are gone from options and schema.
  for (const k of ['TELNET_ENABLED', 'TELNET_PORT']) {
    assert.equal(options.has(k), false, `${k} is not an option`);
    assert.equal(schema.has(k), false, `${k} is not in the schema`);
  }
  // The published container port is the one the server binds by default.
  assert.match(CONFIG, new RegExp(`^  ${SSH_DEFAULT_PORT}/tcp: ${SSH_DEFAULT_PORT}$`, 'm'));
  const desc = /^  2323\/tcp: (.+)$/m.exec(CONFIG.slice(CONFIG.indexOf('ports_description:')));
  assert.ok(desc, 'ports_description has the 2323 row');
  assert.match(desc![1], /SSH/);
  assert.doesNotMatch(desc![1], /[Tt]elnet/);
});

test('ssh config — the translations name the SSH options and no telnet one, in every language', () => {
  const dir = resolve(ROOT, 'ecoflow_panel/translations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 2, `translations: ${files.join(', ')}`);
  for (const f of files) {
    const y = readFileSync(resolve(dir, f), 'utf8');
    for (const key of ['SSH_ENABLED', 'SSH_PORT']) {
      const entry = entryOf(y, key);
      assert.ok(entry.length > 0, `${f}: ${key} entry`);
      const name = /^\s+name: (.+)$/m.exec(entry)?.[1] ?? '';
      const description = /^\s+description: (.+)$/m.exec(entry)?.[1] ?? '';
      assert.ok(name.length > 0 && description.length > 0, `${f}: ${key} has a name and a description`);
      assert.match(name, /SSH/, `${f}: ${key} names SSH`);
      assert.doesNotMatch(entry, /[Tt]elnet/, `${f}: ${key} does not mention telnet`);
    }
    for (const key of ['TELNET_ENABLED', 'TELNET_PORT']) assert.equal(entryOf(y, key), '', `${f}: no ${key} entry`);
    // The console-credential rows describe the SSH console.
    for (const key of ['TUI_USERNAME', 'TUI_PASSWORD']) {
      const entry = entryOf(y, key);
      assert.ok(entry.length > 0, `${f}: ${key} entry`);
      assert.doesNotMatch(entry, /[Tt]elnet/, `${f}: ${key} does not describe telnet`);
      assert.match(entry, /SSH/, `${f}: ${key} names the SSH console`);
    }
  }
});

/* ── 4. options ⇄ translations parity ──────────────────────────────────── */

test('ssh config — every option has a name and a description in every translations file, and no file names a key that is gone', () => {
  // v1.191.0 — every SCHEMA key (a schema-only optional key has no `options:` default but is an option
  // the form shows, so it needs its text too), as scripts/validate-addon-config.py checks.
  const options = section('schema');
  assert.ok(options.size > 50, `parsed only ${options.size} options — parser drifted`);
  const dir = resolve(ROOT, 'ecoflow_panel/translations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const y = readFileSync(resolve(dir, f), 'utf8');
    const cfgAt = y.indexOf('\nconfiguration:');
    assert.notEqual(cfgAt, -1, `${f} has a configuration block`);
    const keys = [...y.slice(cfgAt).matchAll(/^  ([A-Z][A-Z0-9_]+):\s*$/gm)].map((m) => m[1]);
    const missing = [...options.keys()].filter((k) => !keys.includes(k));
    const dead = keys.filter((k) => !options.has(k));
    assert.deepEqual(missing, [], `${f}: options without a translation entry`);
    assert.deepEqual(dead, [], `${f}: translation entries for options that no longer exist (dead text)`);
    for (const k of keys) {
      const entry = entryOf(y, k);
      assert.ok(/^\s+name: \S/m.test(entry), `${f}: ${k} has a name`);
      assert.ok(/^\s+description: \S/m.test(entry), `${f}: ${k} has a description`);
    }
  }
  // The same rule as scripts/validate-addon-config.py applies; run the script itself
  // where PyYAML is installed (the CI job that owns it installs it, the test job does not).
  const hasYaml = spawnSync('python3', ['-I', '-c', 'import yaml'], { stdio: 'ignore' }).status === 0;
  if (hasYaml) {
    const out = execFileSync('python3', ['-I', '-B', resolve(ROOT, 'scripts/validate-addon-config.py')], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /validate-addon-config: OK/);
  } else {
    // Not a skip: the check that cannot run here must be wired into CI.
    assert.match(read('.github/workflows/ci.yml'), /python3 scripts\/validate-addon-config\.py/, 'CI runs validate-addon-config.py');
  }
});
