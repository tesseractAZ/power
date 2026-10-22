import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPTIONS } from '../src/config.js';

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
 *
 * v1.191.0 (S2) — the bridge gains its third side, config.ts OPTIONS, and the rules of plan 2.3
 * (scripts/lib/optionsBridge.mjs): every schema key has a row; every `option` row is exported; a
 * schema-only key (optional, no default — the form every new key takes) may be exported only under
 * `bashio::config.has_value`, so a cleared field never exports the string "null"; the run script's
 * bool convention for a key matches the reader's rule; and a schema range equals the row's clamp
 * (or is declared in DECLARED_DIVERGENCES — optionsDefaultParity.test.ts).
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');
const RUN = readFileSync(resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run'), 'utf8');

interface Bridge {
  strayReferences(run: string, key: string): string[];
  hasValueLine(key: string): string;
  schemaKeys(config: string): Map<string, string>;
  optionKeys(config: string): Map<string, string>;
  schemaOnlyKeys(config: string): string[];
  exportFormOf(run: string, key: string): string;
  bridgeViolations(config: string, run: string, rows: Record<string, { source: string; exportForm?: string }>): string[];
  placementViolations(run: string, key: string): string[];
  assignsKey(line: string, key: string): boolean;
  scriptLayout(run: string): { depthAt: number[]; execLine: number | null };
}
const bridge = (await import(pathToFileURL(resolve(ROOT, 'scripts/lib/optionsBridge.mjs')).href)) as Bridge;

/** Option keys declared in the `schema:` block. */
function schemaKeys(): string[] {
  const keys = [...bridge.schemaKeys(CONFIG).keys()];
  assert.ok(keys.length > 50, `parsed only ${keys.length} schema keys — parser drifted`);
  return keys;
}

/**
 * Options the run script deliberately does not export, each with a reason.
 * Adding to this list is a decision; forgetting to export is an accident. That
 * is the distinction this test exists to force.
 */
const NOT_EXPORTED: Record<string, string> = {};

test('★ every add-on option reaches the process, or is explicitly exempted', () => {
  const keys = schemaKeys();
  const missing = keys.filter((k) => !NOT_EXPORTED[k] && !RUN.includes(`'${k}'`));
  assert.deepEqual(missing, [],
    'these options are declared, shown in the config UI, and stored by the supervisor — '
    + 'but never exported, so the server cannot see them');
});

test('★ the run script exports nothing that the schema no longer declares', () => {
  const keys = new Set(schemaKeys());
  const exported = [...RUN.matchAll(/bashio::config(?:\.true|\.has_value)?\s+'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
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

/* ── v1.191.0: the third side of the bridge, config.ts OPTIONS ─────────────────────────── */

test('★ config.yaml, the run script and config.ts OPTIONS agree (every rule of the bridge)', () => {
  const rows = Object.fromEntries(Object.values(OPTIONS).map((r) => [r.name, { source: r.source, exportForm: r.exportForm }]));
  assert.deepEqual(bridge.bridgeViolations(CONFIG, RUN, rows), []);
});

test('★ every option row names the run script convention its reader needs, and the script uses it', () => {
  for (const key of schemaKeys()) {
    const row = OPTIONS[key];
    assert.ok(row, `${key} has no OPTIONS row`);
    assert.ok(row.exportForm, `${key}: an option row needs an exportForm`);
    assert.equal(bridge.exportFormOf(RUN, key), row.exportForm, `${key}: the run script's convention differs from the reader's rule`);
  }
});

test('the bool conventions in the run script are exactly the two the readers know', () => {
  // v1.191.0 — a schema-only key is exported in the has_value form (the next test's rule), never as a bool.
  const schemaOnly = new Set(bridge.schemaOnlyKeys(CONFIG));
  const forms = new Set(schemaKeys().filter((k) => !schemaOnly.has(k)).map((k) => bridge.exportFormOf(RUN, k)));
  assert.deepEqual([...forms].sort(), ['1/0', 'true/false', 'verbatim']);
  for (const k of schemaOnly) assert.equal(bridge.exportFormOf(RUN, k), 'has_value', `${k}: a schema-only key is exported only under has_value`);
});

test('v1.191.0 — every shipped schema-only key is exported under has_value, and its row says so', () => {
  const only = bridge.schemaOnlyKeys(CONFIG);
  assert.ok(only.includes('SITE_TIMEZONE'), 'lane A ships SITE_TIMEZONE as a schema-only key');
  for (const k of only) {
    assert.equal(bridge.exportFormOf(RUN, k), 'has_value', `${k}: a schema-only key must be exported only under has_value`);
    assert.equal(OPTIONS[k]?.exportForm, 'has_value', `${k}: its OPTIONS row must name the has_value convention`);
  }
});

test('the schema-only mechanism: a key with no default may be exported only under has_value', () => {
  // Fixtures exercise the rule the real files cannot yet (no schema-only key is shipped in S2;
  // the lanes add theirs under the section headings reserved in config.yaml).
  const cfg = 'name: x\noptions:\n  AA: 1\nschema:\n  AA: int\n  BB: "str?"\n  CC: "int(0,5)?"\n';
  const rows = { AA: { source: 'option', exportForm: 'verbatim' }, BB: { source: 'option', exportForm: 'verbatim' }, CC: { source: 'option', exportForm: 'verbatim' } };
  const good = 'export AA="$(bashio::config \'AA\')"\nif bashio::config.has_value \'BB\'; then export BB="$(bashio::config \'BB\')"; fi\nif bashio::config.has_value \'CC\'; then export CC="$(bashio::config \'CC\')"; fi\n';
  assert.deepEqual(bridge.bridgeViolations(cfg, good, rows), []);
  const bare = good.replace('if bashio::config.has_value \'BB\'; then export BB="$(bashio::config \'BB\')"; fi', 'export BB="$(bashio::config \'BB\')"');
  assert.ok(bridge.bridgeViolations(cfg, bare, rows).some((v) => v.startsWith('BB:') && v.includes('has_value')), 'a bare export of a schema-only key must be a violation');
  const notOptional = cfg.replace('  BB: "str?"', '  BB: str');
  assert.ok(bridge.bridgeViolations(notOptional, good, rows).some((v) => v.startsWith('BB:') && v.includes('optional')));
  const unexported = good.replace(/if bashio::config.has_value 'CC'.*\n/, '');
  assert.ok(bridge.bridgeViolations(cfg, unexported, rows).some((v) => v.startsWith('CC:') && v.includes('never exports')));
  const defaultUnderHasValue = good.replace('export AA="$(bashio::config \'AA\')"', 'if bashio::config.has_value \'AA\'; then export AA="$(bashio::config \'AA\')"; fi');
  assert.ok(bridge.bridgeViolations(cfg, defaultUnderHasValue, rows).some((v) => v.startsWith('AA:') && v.includes('unconditionally')));
  const inverted = { ...rows, AA: { source: 'option', exportForm: '1/0' } };
  const boolRun = 'if bashio::config.true \'AA\'; then\n  export AA=true\nelse\n  export AA=false\nfi\n' + good.split('\n').slice(1).join('\n');
  assert.ok(bridge.bridgeViolations(cfg, boolRun, inverted).some((v) => v.startsWith('AA:') && v.includes('inverted')));
  assert.equal(bridge.exportFormOf(boolRun, 'AA'), 'true/false');
  assert.deepEqual(bridge.schemaOnlyKeys(cfg), ['BB', 'CC']);
});

test('★★ v1.191.0 (review) — a schema-only key appears ONLY on its has_value line: every other spelling of an export is a violation', () => {
  // bashio::config returns "null" for a missing key (hassio-addons/bashio lib/config.sh); each of these
  // lines, added next to a correct has_value line, exports that string whenever the field is cleared.
  // The column-0 quoted bare export was the only one the export-form rule saw ('mixed').
  const cfg = 'name: x\noptions:\n  NOTIFY: true\nschema:\n  NOTIFY: bool\n  BB: "str?"\n';
  const rows = { NOTIFY: { source: 'option', exportForm: '1/0' }, BB: { source: 'option', exportForm: 'has_value' } };
  const good = "if bashio::config.true 'NOTIFY'; then\n  export NOTIFY=1\nelse\n  export NOTIFY=0\nfi\n"
    + "if bashio::config.has_value 'BB'; then export BB=\"$(bashio::config 'BB')\"; fi\n";
  assert.deepEqual(bridge.bridgeViolations(cfg, good, rows), []);
  assert.deepEqual(bridge.strayReferences(good, 'BB'), []);
  assert.equal(bridge.hasValueLine('BB'), "if bashio::config.has_value 'BB'; then export BB=\"$(bashio::config 'BB')\"; fi");
  const spellings: Array<[string, string]> = [
    ['indented, inside another block (it runs whenever that block does)', good.replace('  export NOTIFY=1\n', '  export NOTIFY=1\n  export BB="$(bashio::config \'BB\')"\n')],
    ['unquoted', `${good}export BB=$(bashio::config 'BB')\n`],
    ['assigned, then exported', `${good}BB="$(bashio::config 'BB')"; export BB\n`],
    ['a second, indented has_value line', `${good}  if bashio::config.has_value 'BB'; then export BB="$(bashio::config 'BB')"; fi\n`],
    ['a plain re-export of the variable', `${good}export BB\n`],
  ];
  for (const [what, run] of spellings) {
    assert.equal(bridge.exportFormOf(run, 'BB'), 'has_value', `${what}: the export-form rule alone sees only the has_value line`);
    const v = bridge.bridgeViolations(cfg, run, rows);
    assert.ok(v.some((x) => x.startsWith('BB:') && x.includes('only on its one has_value line')), `${what}: must be a violation (got ${JSON.stringify(v)})`);
  }
  // A comment naming the key is not a reference; a key whose name another key extends is not this key.
  const commented = `# BB is the bench-spare list\n${good}`;
  assert.deepEqual(bridge.bridgeViolations(cfg, commented, rows), []);
  const longer = good + "export BB_EXTRA=1\n";
  assert.deepEqual(bridge.strayReferences(longer, 'BB'), []);
});

test('★★★ v1.191.0 (review 3) — every key is set in ONE place, and that place runs (a defaulted key included)', () => {
  // The rule above held only schema-only keys to their one line. A defaulted key was read from its FIRST
  // block, so a later line re-exporting it in another convention passed every test, and in bash the later
  // export wins: `export NOTIFY_CRITICAL_BYPASS_DND=false` turns the DND bypass ON (notify.ts `!== '0'`).
  const cfg = 'name: x\noptions:\n  DND: true\n  GRID: true\n  HOSTX: ""\n  MQTT: false\nschema:\n  DND: bool\n  GRID: bool\n  HOSTX: "str?"\n  MQTT: bool\n  CUR: "str?"\n';
  const rows = {
    DND: { source: 'option', exportForm: '1/0' }, GRID: { source: 'option', exportForm: 'true/false' },
    HOSTX: { source: 'option', exportForm: 'verbatim' }, MQTT: { source: 'option', exportForm: '1/0' }, CUR: { source: 'option', exportForm: 'has_value' },
  };
  const good = [
    'set -e',
    "if bashio::config.true 'DND'; then\n  export DND=1\nelse\n  export DND=0\nfi",
    "if bashio::config.true 'GRID'; then\n  export GRID=true\nelse\n  export GRID=false\nfi",
    'export HOSTX="$(bashio::config \'HOSTX\')"',
    "if bashio::config.has_value 'HOSTX'; then\n  bashio::log.warning \"HOSTX is set ($HOSTX)\"\nfi",
    "if bashio::config.true 'MQTT'; then\n  export MQTT=1\nelse\n  export MQTT=0\nfi",
    "if bashio::config.true 'GRID'; then\n  bashio::log.info \"grid: ${GRID}\"\nfi",
    bridge.hasValueLine('CUR'),
    'bashio::log.info "Starting (dnd ${DND}, grid $GRID)"',
    'cd /app/server',
    'exec npm start',
    '',
  ].join('\n');
  assert.deepEqual(bridge.bridgeViolations(cfg, good, rows), [], 'reads of a key ($KEY in a log line, a has_value guard, a second read-only bool block) are not exports');
  const layout = bridge.scriptLayout(good);
  assert.equal(good.split('\n')[layout.execLine!], 'exec npm start');
  const cases: Array<[string, string, string, RegExp]> = [
    ['B25: a second export of the 1/0 key in the other convention', 'DND',
      good.replace('cd /app/server', 'export DND=false\ncd /app/server'), /DND: exported again outside its one export block/],
    ['B26: a second bool block for the 1/0 key', 'DND',
      good.replace('cd /app/server', "if bashio::config.true 'DND'; then\n  export DND=true\nelse\n  export DND=false\nfi\ncd /app/server"), /DND: exported again outside its one export block/],
    ['B27: a second export of the true/false key', 'GRID',
      good.replace('cd /app/server', 'export GRID=0\ncd /app/server'), /GRID: exported again outside its one export block/],
    ['a verbatim key assigned again', 'HOSTX', good.replace('cd /app/server', 'HOSTX=other; export HOSTX\ncd /app/server'), /HOSTX: exported again/],
    ['B12: the has_value line moved, indented, into another block', 'CUR',
      good.replace(`${bridge.hasValueLine('CUR')}\n`, '').replace('  export MQTT=1\n', `  export MQTT=1\n  ${bridge.hasValueLine('CUR')}\n`), /CUR: its export block is indented/],
    ['B12 at column 0: still inside the block', 'CUR',
      good.replace(`${bridge.hasValueLine('CUR')}\n`, '').replace('  export MQTT=1\n', `  export MQTT=1\n${bridge.hasValueLine('CUR')}\n`), /CUR: its export block is inside another block/],
    ['B14: the has_value line moved below exec', 'CUR',
      good.replace(`${bridge.hasValueLine('CUR')}\n`, '').replace('exec npm start\n', `exec npm start\n${bridge.hasValueLine('CUR')}\n`), /CUR: its export block is below `exec`/],
    ['a bool block moved below exec', 'GRID',
      good.replace("if bashio::config.true 'GRID'; then\n  export GRID=true\nelse\n  export GRID=false\nfi\n", '').replace('exec npm start\n', "exec npm start\nif bashio::config.true 'GRID'; then\n  export GRID=true\nelse\n  export GRID=false\nfi\n"),
      /GRID: its export block is below `exec`/],
  ];
  for (const [what, key, run, why] of cases) {
    assert.ok(bridge.placementViolations(run, key).some((v) => why.test(v)), `${what}: placementViolations (got ${JSON.stringify(bridge.placementViolations(run, key))})`);
    assert.ok(bridge.bridgeViolations(cfg, run, rows).some((v) => why.test(v)), `${what}: bridgeViolations`);
  }
  for (const [line, key, yes] of [
    ['export DND=false', 'DND', true], ['DND=1', 'DND', true], ['  export DND', 'DND', true], ['declare -x DND', 'DND', true],
    ['export A=1 DND', 'DND', true], ['echo "DND=1"', 'DND', false], ['bashio::log.info "dnd ${DND}"', 'DND', false],
    ['# export DND=1', 'DND', false], ['export DND_EXTRA=1', 'DND', false], ['[ "$DND" = 1 ]', 'DND', false],
  ] as const) assert.equal(bridge.assignsKey(line, key), yes, line);
});

test('the config.yaml schema block carries one section heading per lane for the new keys', () => {
  for (const lane of ['site', 'tariff', 'pv', 'ev', 'devices', 'limits']) {
    assert.ok(CONFIG.includes(`# --- lane ${lane} ---`), `config.yaml schema: lacks the "# --- lane ${lane} ---" heading`);
  }
});
