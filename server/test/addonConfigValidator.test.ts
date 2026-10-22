import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S2) — scripts/validate-addon-config.py compares the translation files against the SCHEMA
 * keys, so a schema-only key (optional, no default — the form every new key takes) must carry a label
 * in every language, and a key with a default must have a schema. Run against fixture trees through
 * the script's root argument; the real tree is checked in CI.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'validate-addon-config.py');

function run(files: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'addon-config-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const r = spawnSync('python3', ['-I', '-B', SCRIPT, dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = (schemaOnly = '  SITE_TIMEZONE: "str?"\n') =>
  `name: x\noptions:\n  LOG_LEVEL: info\nschema:\n  LOG_LEVEL: list(info|debug)\n${schemaOnly}`;
const translation = (keys: string[]) =>
  `configuration:\n${keys.map((k) => `  ${k}:\n    name: ${k} label\n    description: What ${k} does.\n`).join('')}`;

test('a schema-only optional key needs a translation in every language', () => {
  const ok = run({ 'ecoflow_panel/config.yaml': config(), 'ecoflow_panel/translations/en.yaml': translation(['LOG_LEVEL', 'SITE_TIMEZONE']), 'ecoflow_panel/translations/es.yaml': translation(['LOG_LEVEL', 'SITE_TIMEZONE']) });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /2 options \(1 schema-only\)/);
  const missing = run({ 'ecoflow_panel/config.yaml': config(), 'ecoflow_panel/translations/en.yaml': translation(['LOG_LEVEL', 'SITE_TIMEZONE']), 'ecoflow_panel/translations/es.yaml': translation(['LOG_LEVEL']) });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /\[es\] options with no translation .*SITE_TIMEZONE/);
});

test('a schema-only key must be optional, and a default must have a schema', () => {
  const notOptional = run({ 'ecoflow_panel/config.yaml': config('  SITE_TIMEZONE: str\n'), 'ecoflow_panel/translations/en.yaml': translation(['LOG_LEVEL', 'SITE_TIMEZONE']) });
  assert.equal(notOptional.status, 1);
  assert.match(notOptional.out, /SITE_TIMEZONE has a schema but no default; a schema-only key must be optional/);
  const noSchema = run({ 'ecoflow_panel/config.yaml': 'name: x\noptions:\n  LOG_LEVEL: info\n  EXTRA: 1\nschema:\n  LOG_LEVEL: str\n', 'ecoflow_panel/translations/en.yaml': translation(['LOG_LEVEL']) });
  assert.equal(noSchema.status, 1);
  assert.match(noSchema.out, /EXTRA has an options: default but no schema entry/);
});

test('a translation for a key the schema does not declare is dead text', () => {
  const orphan = run({ 'ecoflow_panel/config.yaml': config(''), 'ecoflow_panel/translations/en.yaml': translation(['LOG_LEVEL', 'GONE']) });
  assert.equal(orphan.status, 1);
  assert.match(orphan.out, /translations for options that no longer exist .*GONE/);
});
