/**
 * The SSH console's option aliases and its options→env contract.
 *
 * `SSH_ENABLED` / `SSH_PORT` are the console's options; `TELNET_ENABLED` /
 * `TELNET_PORT` are kept as deprecated aliases (an option key is never renamed or
 * nested). Home Assistant merges every option default into the saved options, so
 * an alias is "unset" when it is at its shipped default — the resolver in
 * config.ts applies the TELNET_* value while the SSH_* one is at its default, and
 * reports each alias that decided a value for one boot notice.
 *
 *   1. resolveSshConfig — the matrix, including the install that only ever set
 *      TELNET_ENABLED / TELNET_PORT (SSH on, same port, exactly one notice).
 *   2. The run script exports both pairs, the fixed host and host-key path, and
 *      nothing the schema no longer declares; config.ts reads SSH_PORT.
 *   3. config.yaml publishes the port SSH_PORT defaults to; the aliases stay in
 *      options and schema; the translations describe them as deprecated.
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

/** The owner-style install: the console was turned on with the telnet option; the new keys sit at their defaults. */
const LEGACY_ENV = { SSH_ENABLED: '0', SSH_PORT: '2323', TELNET_ENABLED: '1', TELNET_PORT: '2323', SSH_HOST: '::', SSH_HOST_KEY: '/data/ssh_host_ed25519_key' };

/* ── 1. the resolver ───────────────────────────────────────────────────── */

test('ssh config — an install that only set TELNET_ENABLED comes up over SSH on the same port with exactly one notice', () => {
  const c = resolveSshConfig(LEGACY_ENV);
  assert.equal(c.enabled, true);
  assert.equal(c.port, 2323);
  assert.equal(c.host, '::');
  assert.equal(c.hostKeyPath, '/data/ssh_host_ed25519_key');
  assert.equal(c.deprecationNotes.length, 1, c.deprecationNotes.join(' | '));
  assert.match(c.deprecationNotes[0], /deprecated TELNET_ENABLED option is on; set SSH_ENABLED instead/);
});

test('ssh config — SSH_ENABLED decides on its own; both off means off; a bare env stays on', () => {
  assert.equal(resolveSshConfig({ SSH_ENABLED: '1', TELNET_ENABLED: '0' }).enabled, true);
  assert.deepEqual(resolveSshConfig({ SSH_ENABLED: '1', TELNET_ENABLED: '0' }).deprecationNotes, []);
  assert.equal(resolveSshConfig({ SSH_ENABLED: '1', TELNET_ENABLED: '1' }).enabled, true);
  assert.deepEqual(resolveSshConfig({ SSH_ENABLED: '1', TELNET_ENABLED: '1' }).deprecationNotes, [], 'no notice when the new option already says on');
  const off = resolveSshConfig({ SSH_ENABLED: '0', TELNET_ENABLED: '0' });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.deprecationNotes, []);
  // Dev / tests with neither exported: on, as `TELNET_ENABLED !== '0'` was.
  const bare = resolveSshConfig({});
  assert.equal(bare.enabled, true);
  assert.equal(bare.port, SSH_DEFAULT_PORT);
  assert.equal(bare.host, '::');
  assert.equal(bare.hostKeyPath, '/data/ssh_host_ed25519_key');
  assert.deepEqual(bare.deprecationNotes, []);
});

test('ssh config — SSH_PORT wins; at its default it defers to a changed TELNET_PORT, with a notice', () => {
  assert.equal(resolveSshConfig({ SSH_PORT: '2400', TELNET_PORT: '2323' }).port, 2400);
  assert.deepEqual(resolveSshConfig({ SSH_PORT: '2400', TELNET_PORT: '2323' }).deprecationNotes, []);
  assert.equal(resolveSshConfig({ SSH_PORT: '2400', TELNET_PORT: '2500' }).port, 2400, 'a set SSH_PORT is never overridden');
  assert.deepEqual(resolveSshConfig({ SSH_PORT: '2400', TELNET_PORT: '2500' }).deprecationNotes, []);
  const alias = resolveSshConfig({ SSH_PORT: '2323', TELNET_PORT: '2400' });
  assert.equal(alias.port, 2400);
  assert.equal(alias.deprecationNotes.length, 1);
  assert.match(alias.deprecationNotes[0], /SSH_PORT is at its default and the deprecated TELNET_PORT is 2400: TELNET_PORT applies/);
  // Both aliases in use: two notices, one each.
  assert.equal(resolveSshConfig({ ...LEGACY_ENV, TELNET_PORT: '2400' }).deprecationNotes.length, 2);
  // An empty or unparsable alias never decides anything.
  assert.equal(resolveSshConfig({ SSH_PORT: '2323', TELNET_PORT: '' }).port, 2323);
  assert.equal(resolveSshConfig({ SSH_PORT: '2323', TELNET_PORT: 'nope' }).port, 2323);
  assert.deepEqual(resolveSshConfig({ SSH_PORT: '2323', TELNET_PORT: 'nope' }).deprecationNotes, []);
});

test('ssh config — host and host-key path come from SSH_HOST / SSH_HOST_KEY, with TELNET_HOST as the host fallback', () => {
  assert.equal(resolveSshConfig({ SSH_HOST: '127.0.0.1', TELNET_HOST: '0.0.0.0' }).host, '127.0.0.1');
  assert.equal(resolveSshConfig({ TELNET_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(resolveSshConfig({ SSH_HOST_KEY: '/tmp/k' }).hostKeyPath, '/tmp/k');
});

/* ── 2. the options→env bridge ─────────────────────────────────────────── */

test('ssh config — the run script exports SSH_ENABLED 1/0, SSH_PORT, the fixed host and key path, and the deprecated pair', () => {
  const block = RUN.slice(RUN.indexOf("bashio::config.true 'SSH_ENABLED'"));
  const body = block.slice(0, block.indexOf('\nfi'));
  assert.match(body, /export SSH_ENABLED=1/);
  assert.match(body, /export SSH_ENABLED=0/);
  assert.ok(!/SSH_ENABLED=(true|false)/.test(body), 'config.ts reads `!== \'0\'`; the string false would read as on');
  assert.match(RUN, /^export SSH_HOST=::$/m);
  assert.match(RUN, /^export SSH_PORT="\$\(bashio::config 'SSH_PORT'\)"$/m);
  assert.match(RUN, /^export SSH_HOST_KEY=\/data\/ssh_host_ed25519_key$/m, 'the key path is a literal, as config.ts and the AppArmor /data rule expect');
  // The aliases are still exported (config.ts resolves them); TELNET_HOST is not (nothing declares it).
  assert.match(RUN, /bashio::config\.true 'TELNET_ENABLED'/);
  assert.match(RUN, /^export TELNET_PORT="\$\(bashio::config 'TELNET_PORT'\)"$/m);
  assert.doesNotMatch(RUN, /TELNET_HOST/);
  // config.ts reads the exported names.
  const cfg = read('server/src/config.ts');
  assert.match(cfg, /env\.SSH_PORT \?\? SSH_DEFAULT_PORT/);
  assert.match(cfg, /env\.SSH_ENABLED !== '0'/);
  assert.match(cfg, /env\.TELNET_ENABLED === '1'/);
  assert.match(cfg, /env\.SSH_HOST_KEY \?\? '\/data\/ssh_host_ed25519_key'/);
});

test('ssh config — the call site puts the host key fingerprint on the startup line and logs every alias notice', () => {
  const idx = read('server/src/index.ts');
  assert.match(idx, /for \(const n of config\.ssh\.deprecationNotes\) app\.log\.warn\(`ssh: \$\{n\}`\);/, 'one boot notice per alias that decided a value');
  assert.match(idx, /loadOrCreateHostKey\(config\.ssh\.hostKeyPath,/, 'the host key comes from the configured path');
  assert.match(idx, /\$\{describeSshAuth\(authFromEnv\(\)\)\} — host key \$\{hostKey\.fingerprint\}`\)/, 'the fingerprint is on the startup line at every start');
  assert.doesNotMatch(idx, /startTelnetServer|config\.telnet\b/);
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

test('ssh config — config.yaml publishes the port SSH_PORT defaults to, keeps the aliases, and says SSH', () => {
  const options = section('options');
  const schema = section('schema');
  assert.equal(options.get('SSH_ENABLED'), 'false', 'off by default (CWE-1188)');
  assert.equal(Number(options.get('SSH_PORT')), SSH_DEFAULT_PORT);
  assert.equal(schema.get('SSH_ENABLED'), 'bool');
  assert.equal(schema.get('SSH_PORT'), 'port');
  // The deprecated aliases are never renamed or removed, and their defaults are the SSH ones.
  assert.equal(options.get('TELNET_ENABLED'), 'false');
  assert.equal(Number(options.get('TELNET_PORT')), SSH_DEFAULT_PORT);
  assert.equal(schema.get('TELNET_ENABLED'), 'bool');
  assert.equal(schema.get('TELNET_PORT'), 'port');
  // The published container port is the one the server binds by default.
  assert.match(CONFIG, new RegExp(`^  ${SSH_DEFAULT_PORT}/tcp: ${SSH_DEFAULT_PORT}$`, 'm'));
  const desc = /^  2323\/tcp: (.+)$/m.exec(CONFIG.slice(CONFIG.indexOf('ports_description:')));
  assert.ok(desc, 'ports_description has the 2323 row');
  assert.match(desc![1], /SSH/);
  assert.doesNotMatch(desc![1], /[Tt]elnet/);
});

test('ssh config — the translations name the new options and mark the old ones deprecated, in every language', () => {
  const dir = resolve(ROOT, 'ecoflow_panel/translations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 2, `translations: ${files.join(', ')}`);
  for (const f of files) {
    const y = readFileSync(resolve(dir, f), 'utf8');
    for (const key of ['SSH_ENABLED', 'SSH_PORT', 'TELNET_ENABLED', 'TELNET_PORT']) {
      const entry = entryOf(y, key);
      assert.ok(entry.length > 0, `${f}: ${key} entry`);
      const name = /^\s+name: (.+)$/m.exec(entry)?.[1] ?? '';
      const description = /^\s+description: (.+)$/m.exec(entry)?.[1] ?? '';
      assert.ok(name.length > 0 && description.length > 0, `${f}: ${key} has a name and a description`);
      if (key.startsWith('TELNET_')) {
        assert.match(name, /\((deprecated|obsoleto)\)$/, `${f}: ${key} is named deprecated`);
      } else {
        assert.match(name, /SSH/, `${f}: ${key} names SSH`);
        assert.doesNotMatch(name, /[Tt]elnet/);
      }
    }
    // The console-credential rows no longer describe a telnet transport.
    for (const key of ['TUI_USERNAME', 'TUI_PASSWORD']) {
      const entry = entryOf(y, key);
      assert.ok(entry.length > 0, `${f}: ${key} entry`);
      assert.doesNotMatch(entry, /telnet/i, `${f}: ${key} does not describe telnet`);
      assert.match(entry, /SSH/, `${f}: ${key} names the SSH console`);
    }
  }
});

/* ── 4. options ⇄ translations parity ──────────────────────────────────── */

test('ssh config — every option has a name and a description in every translations file, and no file names a key that is gone', () => {
  const options = section('options');
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
