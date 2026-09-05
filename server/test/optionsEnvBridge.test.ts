import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * v1.124.2 — THE OPTIONS -> ENV BRIDGE.
 *
 * An add-on option is inert until `rootfs/etc/services.d/ecoflow-panel/run`
 * exports it: the schema declares it, the config UI shows it, the supervisor
 * stores it, and the server never sees it. Nothing else in the build catches
 * that — TypeScript cannot, and every unit test passes because the code reads
 * `process.env` which the test sets directly.
 *
 * It has now happened twice in this codebase's history in the same shape (v0.33
 * shipped a keybinding wired and mutation-proven everywhere except the one
 * literal that reaches production; v1.124.0 shipped NOTIFY_HA_PUSH_TARGETS the
 * same way and it read as an empty target list on the live system). The whole
 * suite was green both times.
 *
 * So the invariant is asserted where it actually lives: schema keys against the
 * run script.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');
const RUN = readFileSync(resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run'), 'utf8');

/** Option keys declared in the `schema:` block. */
function schemaKeys(): string[] {
  const i = CONFIG.indexOf('\nschema:');
  assert.notEqual(i, -1, 'config.yaml must have a schema block');
  return (CONFIG.slice(i).match(/^  ([A-Z][A-Z0-9_]+):/gm) ?? [])
    .map((m) => m.trim().replace(':', ''));
}

/**
 * Options the run script deliberately does not export, each with a reason.
 * Adding to this list is a decision; forgetting to export is an accident. That
 * is the distinction this test exists to force.
 */
const NOT_EXPORTED: Record<string, string> = {};

test('★ every add-on option reaches the process, or is explicitly exempted', () => {
  const keys = schemaKeys();
  assert.ok(keys.length > 50, `parsed only ${keys.length} schema keys — parser drifted`);
  const missing = keys.filter((k) => !NOT_EXPORTED[k] && !RUN.includes(`'${k}'`));
  assert.deepEqual(missing, [],
    'these options are declared, shown in the config UI, and stored by the supervisor — '
    + 'but never exported, so the server cannot see them');
});

test('★ the run script exports nothing that the schema no longer declares', () => {
  const keys = new Set(schemaKeys());
  const exported = [...RUN.matchAll(/bashio::config(?:\.true)?\s+'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
  const orphans = [...new Set(exported)].filter((k) => !keys.has(k));
  assert.deepEqual(orphans, [],
    'bashio::config on a key with no schema entry yields an empty value at boot and hides a typo');
});

test('the notify push settings specifically are wired', () => {
  // The two that shipped inert in v1.124.0.
  assert.match(RUN, /export NOTIFY_HA_PUSH_TARGETS="\$\(bashio::config 'NOTIFY_HA_PUSH_TARGETS'\)"/);
  assert.match(RUN, /bashio::config\.true 'NOTIFY_CRITICAL_BYPASS_DND'/);
});

test('NOTIFY_CRITICAL_BYPASS_DND uses the 1/0 convention its reader expects', () => {
  // This file uses TWO bool conventions: 1/0 (NOTIFY_RESOLVED) and true/false
  // (NIGHT_CHARGE_NOTIFY_ON_HOLD). notify.ts reads `!== '0'`, so exporting the
  // string "false" would read as TRUE and silently keep the DND bypass on.
  const block = RUN.slice(RUN.indexOf("bashio::config.true 'NOTIFY_CRITICAL_BYPASS_DND'"));
  const body = block.slice(0, block.indexOf('\nfi'));  // '\nfi', not 'fi' — "config" contains it
  assert.match(body, /export NOTIFY_CRITICAL_BYPASS_DND=1/);
  assert.match(body, /export NOTIFY_CRITICAL_BYPASS_DND=0/);
  assert.ok(!/NOTIFY_CRITICAL_BYPASS_DND=(true|false)/.test(body),
    'the true/false convention here would invert the meaning of "off"');
});
