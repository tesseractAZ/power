import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { OPTIONS } from '../src/config.js';

/**
 * v1.191.0 (review 3) — THE RUN SCRIPT, RUN.
 *
 * optionsEnvBridge.test.ts reads `rootfs/etc/services.d/ecoflow-panel/run` as text: it finds each
 * key's export and checks its spelling. Text rules miss what only running the script shows: an export
 * moved inside another `if` runs only when that one does, one moved below `exec` never runs, and a
 * second export later in the file wins (`export NOTIFY_CRITICAL_BYPASS_DND=false` turns the DND bypass
 * on, notify.ts reading `!== '0'`). Each passed the whole suite.
 *
 * So the script itself runs here, under bash, with bashio's config functions stubbed over fixture
 * options (bashio semantics: a missing or null key reads as the string "null"; `config.true` is the
 * string "true"; `has_value` is neither "null" nor empty). `cd` is a no-op and `exec` writes the
 * environment the server would start with. That environment must be exactly what each key's reader
 * expects (config.ts `exportForm`), over fixtures that put every bool both ways, every string at its
 * default and at another value, and every schema-only key absent, cleared and set.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const RUN_PATH = resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run');
const CONFIG = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');

interface Bridge {
  schemaKeys(config: string): Map<string, string>;
  optionKeys(config: string): Map<string, string>;
}
const bridge = (await import(pathToFileURL(resolve(ROOT, 'scripts/lib/optionsBridge.mjs')).href)) as Bridge;
const SCHEMA = bridge.schemaKeys(CONFIG);
const DEFAULTS = bridge.optionKeys(CONFIG);

/** A stored option as the Supervisor holds it: a JSON boolean, a string, or null (cleared). */
type Stored = string | boolean | null;
const isBool = (key: string) => /^"?bool\??"?$/.test(SCHEMA.get(key) ?? '');

/** The constants the image sets whatever the options say (config.ts rows of source 'deploy'). */
const DEPLOY: Record<string, string> = {
  PORT: '8787', HOST: '::', DB_PATH: '/data/ecoflow.db', WEB_DIST_PATH: '/app/web/dist',
  SSH_HOST: '::', SSH_HOST_KEY: '/data/ssh_host_ed25519_key',
};
/** What a bare bash puts in the environment on its own, and the harness's two variables. */
const SHELL_OWN = new Set(['PATH', 'PWD', 'OLDPWD', 'SHLVL', '_', '__RUN', '__RUN_ENV_OUT']);

const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** Run the script over `stored`; the environment `exec` was reached with, or null when it was not. */
function runWith(stored: Record<string, Stored>): { env: Map<string, string> | null; status: number | null; stderr: string } {
  const cases = Object.entries(stored)
    .map(([k, v]) => `    ${sq(k)}) printf '%s' ${sq(v === null ? 'null' : String(v))} ;;`).join('\n');
  const prelude = [
    'bashio::config() {',
    '  case "$1" in',
    cases,
    "    *) printf '%s' 'null' ;;",
    '  esac',
    '}',
    'bashio::config.true() { [ "$(bashio::config "$1")" = "true" ]; }',
    'bashio::config.has_value() { local v; v="$(bashio::config "$1")"; [ "$v" != "null" ] && [ -n "$v" ]; }',
    'bashio::var.is_empty() { [ -z "$1" ]; }',
    'bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.fatal() { :; }; bashio::log.notice() { :; }',
    'sleep() { :; }',
    'cd() { :; }',
    // The server's start: the environment it inherits, NUL-separated (a value may hold a newline).
    'exec() { for __v in $(compgen -e); do printf \'%s=%s\\0\' "$__v" "${!__v}"; done > "$__RUN_ENV_OUT"; exit 0; }',
    'source "$__RUN"',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'run-script-env-'));
  const out = join(dir, 'env');
  try {
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', prelude], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', __RUN: RUN_PATH, __RUN_ENV_OUT: out }, encoding: 'utf8', timeout: 20_000,
    });
    if (r.error) throw r.error;
    if (!existsSync(out)) return { env: null, status: r.status, stderr: r.stderr };
    const env = new Map<string, string>();
    for (const pair of readFileSync(out, 'utf8').split('\0')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      env.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { env, status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The environment each reader expects for `stored` (config.ts exportForm; DEPLOY). */
function expectedEnv(stored: Record<string, Stored>): Map<string, string> {
  const env = new Map<string, string>(Object.entries(DEPLOY));
  for (const key of SCHEMA.keys()) {
    const form = OPTIONS[key]?.exportForm;
    const v = key in stored ? stored[key] : null;
    const text = v === null ? 'null' : String(v);
    if (form === '1/0') env.set(key, text === 'true' ? '1' : '0');
    else if (form === 'true/false') env.set(key, text === 'true' ? 'true' : 'false');
    else if (form === 'verbatim') env.set(key, text);
    else if (form === 'has_value') { if (text !== 'null' && text !== '') env.set(key, text); }
    else throw new Error(`${key}: no exportForm on its OPTIONS row`);
  }
  return env;
}

function projected(env: Map<string, string>): { known: Record<string, string>; unknown: string[] } {
  const known: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [k, v] of [...env].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (SCHEMA.has(k) || k in DEPLOY) known[k] = v;
    else if (!SHELL_OWN.has(k)) unknown.push(k);
  }
  return { known, unknown };
}

const CREDENTIALS = { ECOFLOW_ACCESS_KEY: 'test-access', ECOFLOW_SECRET_KEY: 'test-secret' };
const schemaOnly = [...SCHEMA.keys()].filter((k) => !DEFAULTS.has(k));
/** Every stored option at its shipped default (a bool as a JSON boolean). */
function atDefaults(): Record<string, Stored> {
  const o: Record<string, Stored> = {};
  for (const [k, d] of DEFAULTS) o[k] = isBool(k) ? d === 'true' : d;
  return { ...o, ...CREDENTIALS };
}
/** Every stored option at another value: each bool flipped, each string a distinct one with a space. */
function flipped(): Record<string, Stored> {
  const o: Record<string, Stored> = {};
  for (const [k, d] of DEFAULTS) o[k] = isBool(k) ? d !== 'true' : `set ${k}`;
  return { ...o, ...CREDENTIALS };
}
/** Every schema-only key set (a bool to true), or cleared to `clear`. */
function schemaOnlyAt(clear?: '' | null): Record<string, Stored> {
  const o: Record<string, Stored> = {};
  for (const k of schemaOnly) o[k] = clear !== undefined ? clear : isBool(k) ? true : `only ${k}`;
  return o;
}

const FIXTURES: Array<[string, Record<string, Stored>]> = [
  ['the shipped defaults, every schema-only key absent', atDefaults()],
  ['the shipped defaults, every schema-only key set', { ...atDefaults(), ...schemaOnlyAt() }],
  ['every bool flipped and every string changed, every schema-only key set', { ...flipped(), ...schemaOnlyAt() }],
  ['every bool flipped and every string changed, every schema-only key cleared to ""', { ...flipped(), ...schemaOnlyAt('') }],
  ['every bool flipped and every string changed, every schema-only key cleared to null', { ...flipped(), ...schemaOnlyAt(null) }],
];

test('precondition: bash runs the stubbed script to exec', () => {
  assert.ok(schemaOnly.length >= 30, `parsed ${schemaOnly.length} schema-only keys — parser drifted`);
  assert.ok(DEFAULTS.size >= 80, `parsed ${DEFAULTS.size} defaulted keys — parser drifted`);
  const r = runWith(atDefaults());
  assert.ok(r.env, `exec was not reached (status ${r.status}): ${r.stderr}`);
});

for (const [what, stored] of FIXTURES) {
  test(`★★★ the environment at exec is exactly what each reader expects: ${what}`, () => {
    const r = runWith(stored);
    assert.ok(r.env, `exec was not reached (status ${r.status}): ${r.stderr}`);
    const got = projected(r.env);
    assert.deepEqual(got.unknown, [], 'the script exports a variable that is neither an option nor a deployment constant');
    assert.deepEqual(got.known, Object.fromEntries([...expectedEnv(stored)].sort(([a], [b]) => (a < b ? -1 : 1))));
  });
}

test('★★ the deployment constants are config.ts deploy rows', () => {
  for (const k of Object.keys(DEPLOY)) assert.equal(OPTIONS[k]?.source, 'deploy', `${k} is not a deploy row`);
});

test('★★ with no credentials the script stops before exec (the server never starts keyless)', () => {
  const r = runWith({ ...atDefaults(), ECOFLOW_ACCESS_KEY: '', ECOFLOW_SECRET_KEY: '' });
  assert.equal(r.env, null, 'exec was reached without credentials');
  assert.equal(r.status, 1);
});
