#!/usr/bin/env node
/**
 * mutate-v1191-s2.mjs — v1.191.0 S2: the option table, its parsers and the bridge gates.
 *
 *   S2-i     a true/false key is parsed `!== '0'` (the inverted-DND failure: "false" reads ON)
 *   S2-ii    a blank optional field reads as 0 for a `?? d` key (GRID_FLOOR_SLACK_PCT)
 *   S2-iii   a clamp is dropped (HEARTBEAT_INTERVAL_S accepts 99999 s)
 *   S2-iv    a schema-only key exported unconditionally passes the bridge (exports the string "null")
 *   S2-v     a declared divergence is removed from the list (SSH_ENABLED unset-on goes unstated)
 *   S2-vi    a row claims the wrong run-script convention (NOTIFY_CRITICAL_BYPASS_DND as true/false)
 *   S2-vii   a module outside config.ts reads process.env (the ratchet)
 *   S2-viii  check-docs D7 accepts a non-optional schema-only key
 *   S2-ix    check-docs D4 knows options: keys only (a schema-only key named in the guide fails)
 *   S2-x     the add-on validator compares translations against options: keys only
 *   S2-xi    the tariff cents accept positive values only (the KPI rule leaks into the model path)
 *   S2-xii   the notify-hour clamp widens to 23 (the evening job's window becomes empty at 23)
 *   S2-xiii  an absent LOAD_SHEDDING_SHED_ENTITIES stops reading like the exported default
 *   S2-xiv   the bridge no longer holds the run script to the reader's bool convention
 *   S2-xv    the in-add-on DB_PATH default falls back to the relative path
 *   S2-xvi   a new read by destructuring process (const { env } = process) passes the ratchet
 *   S2-xvii  a new read as process['env'].NAME passes the ratchet
 *   S2-xviii a read's name is swapped for an unregistered one (every count unchanged)
 *   S2-xix   a new knob read through an existing dynamic-name helper (selfVitals.ts num)
 *   S2-xx    a new read through import { env } from 'node:process'
 *   S2-xxi   the bridge accepts a second spelling of a schema-only export beside its has_value line
 *   S2-xxii  the bridge accepts a second copy of the has_value line
 *
 *   cd server && node ../scripts/mutate-v1191-s2.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(REPO, 'server/src/config.ts');
const ONSET = resolve(REPO, 'server/src/alertOnset.ts');
const VITALS = resolve(REPO, 'server/src/selfVitals.ts');
const SITE = resolve(REPO, 'server/src/site.ts');
const BRIDGE = resolve(REPO, 'scripts/lib/optionsBridge.mjs');
const CD = resolve(REPO, 'scripts/check-docs.mjs');
const VALIDATOR = resolve(REPO, 'scripts/validate-addon-config.py');
const SUBSET = [
  'test/golden.test.ts',
  'test/optionsDefaultParity.test.ts',
  'test/optionsEnvBridge.test.ts',
  'test/processEnvRatchet.test.ts',
  'test/docsLayout.test.ts',
  'test/addonConfigValidator.test.ts',
  'test/configDbPath.test.ts',
];

const MUTANTS = [
  {
    id: 'S2-i. ★★★ a true/false key parsed `!== \'0\'` (the inverted-DND failure)',
    file: CONFIG,
    find: "doc: 'Master enable for audible broadcast (the /data runtime override wins when set).', parse: bool('trueOr1') }),",
    to: "doc: 'Master enable for audible broadcast (the /data runtime override wins when set).', parse: bool('not0') }), /* MUTANT */",
    why: 'The run script exports "false"; `!== \'0\'` reads it as ON — every speaker announces on an install that switched broadcast off.',
  },
  {
    id: 'S2-ii. ★★★ a blank optional field reads as 0 for a `?? d` key',
    file: CONFIG,
    find: "    parse: (raw) => { if (raw == null || raw.trim() === '' || raw === 'null') return 1.5; const n = Number(raw); return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 1.5; } }),",
    to: "    parse: (raw) => Math.min(10, Math.max(0, Number(raw ?? 1.5))) }), /* MUTANT */",
    why: 'A cleared GRID_FLOOR_SLACK_PCT field reads as 0 slack instead of 1.5: the flow-less grid is distrusted only at the floor itself.',
  },
  {
    id: 'S2-iii. ★★★ a clamp is dropped',
    file: CONFIG,
    find: "return Math.min(3600, Math.max(60, v)) * 1000; } }),",
    to: "return v * 1000; } }), /* MUTANT */",
    why: 'HEARTBEAT_INTERVAL_S=99999 pings once a day; the outside dead-man alerts for 27 hours of silence that is not an outage.',
  },
  {
    id: 'S2-iv. ★★★ a schema-only key exported unconditionally passes the bridge',
    file: BRIDGE,
    find: "      if (form !== 'none' && form !== 'has_value') out.push(`${key}: a schema-only key may be exported only as",
    to: "      if (false) out.push(`${key}: a schema-only key may be exported only as /* MUTANT */",
    why: 'A cleared optional field is exported as the string "null"; SITE_TIMEZONE="null" fails zone validation on every boot.',
  },
  {
    id: 'S2-v. ★★★ a declared divergence is removed from the list',
    file: CONFIG,
    find: "  { key: 'SSH_ENABLED', kind: 'unset', code: 'on', yaml: 'false', reason:",
    to: "  { key: 'SSH_ENABLED_REMOVED', kind: 'unset', code: 'on', yaml: 'false', reason: /* MUTANT */",
    why: 'The table says every unset value equals its default while SSH_ENABLED unset is ON: the one place that difference is written down is gone.',
  },
  {
    id: 'S2-vi. ★★★ a row claims the wrong run-script convention',
    file: CONFIG,
    find: "row({ name: 'NOTIFY_CRITICAL_BYPASS_DND', source: 'option', exportForm: '1/0',",
    to: "row({ name: 'NOTIFY_CRITICAL_BYPASS_DND', source: 'option', exportForm: 'true/false', /* MUTANT */",
    why: 'The bridge accepts a run script that exports "false" to a `!== \'0\'` reader — the v1.124.0 inversion, undetected again.',
  },
  {
    id: 'S2-vii. ★★ a module outside config.ts reads process.env',
    file: SITE,
    find: "export const siteZoneInput = (): string => siteTimeZone();", // site.ts's zone input: lane A's resolved zone
    to: "export const siteZoneInput = (): string => process.env.TZ ?? siteTimeZone(); /* MUTANT */",
    why: 'A second reader of the zone appears outside the table; the ratchet exists so this is caught on the day it is written.',
  },
  {
    id: 'S2-viii. ★★ check-docs D7 accepts a non-optional schema-only key',
    file: CD,
    find: "      for (const k of config.schema.keys()) if (!config.options.has(k) && !isOptionalSchema(config.schema.get(k))) fail('D7',",
    to: "      for (const k of config.schema.keys()) if (false) fail('D7', /* MUTANT */",
    why: 'A required field with no default ships: the Configuration tab refuses to save until the user invents a value.',
  },
  {
    id: 'S2-ix. ★★ check-docs D4 knows options: keys only',
    file: CD,
    find: "    const keys = config ? [...config.schema.keys()] : [];",
    to: "    const keys = config ? [...config.options.keys()] : []; /* MUTANT */",
    why: 'Naming a new schema-only key in the operator guide fails D4, so the guide cannot document the keys this release adds.',
  },
  {
    id: 'S2-x. ★★ the add-on validator compares translations against options: keys only',
    file: VALIDATOR,
    find: "        missing = sorted(set(schema) - set(entries))",
    to: "        missing = sorted(set(options) - set(entries))  # MUTANT",
    why: 'A schema-only key with no translation passes; Home Assistant shows the raw KEY as its label.',
  },
  {
    id: 'S2-xi. ★★★ the tariff cents accept positive values only',
    file: CONFIG,
    find: "      parse: cent() })),",
    to: "      parse: centPositive() })), /* MUTANT */",
    why: 'A 0 ¢ period reads as unconfirmed on the model path: the night-charge advisor holds on a plan that prices a free window (OWNER DECISION 8 keeps the model rule).',
  },
  {
    id: 'S2-xii. ★★★ the notify-hour clamp widens to 23',
    file: CONFIG,
    find: "parse: intClampedNum(21, 0, 22) }),",
    to: "parse: intClampedNum(21, 0, 23) }), /* MUTANT */",
    why: 'NIGHT_CHARGE_NOTIFY_HOUR=23 makes the evening job\'s [fire, 23:00) window empty: no plan is ever recorded or announced.',
  },
  {
    id: 'S2-xiii. ★★ an absent LOAD_SHEDDING_SHED_ENTITIES stops reading like the exported default',
    file: CONFIG,
    find: "parse: (raw) => raw ?? '' }),",
    to: "parse: (raw) => raw }), /* MUTANT */",
    why: 'Absent and blank diverge for a key whose reader treats them alike; the parity table misreports the add-on\'s own default.',
  },
  {
    id: 'S2-xiv. ★★★ the bridge no longer holds the run script to the reader\'s bool convention',
    file: BRIDGE,
    find: "      else if (row.exportForm && form !== row.exportForm) out.push(`${key}: the run script exports it as ${form} but its reader expects ${row.exportForm} (the inverted-flag failure)`);",
    to: "      else if (false) out.push(`${key}: the run script exports it as ${form} but its reader expects ${row.exportForm} (the inverted-flag failure)`); /* MUTANT */",
    why: 'A run script that switches a key from 1/0 to true/false passes; the reader inverts the option.',
  },
  {
    id: 'S2-xv. ★★★ the in-add-on DB_PATH default falls back to the relative path',
    file: CONFIG,
    find: "    parse: (raw, env) => raw ?? (env.get('SUPERVISOR_TOKEN') ? '/data/ecoflow.db' : '../data/ecoflow.db') }),",
    to: "    parse: (raw) => raw ?? '../data/ecoflow.db' }), /* MUTANT */",
    why: 'A dropped DB_PATH export inside the container writes state under /app, which the AppArmor profile denies: the add-on aborts at boot (v1.7.2).',
  },
  {
    id: 'S2-xvi. ★★ a new read by destructuring process passes the ratchet',
    file: SITE,
    find: "export const siteZoneInput = (): string => siteTimeZone();",
    to: "const { env: envAlias } = process; export const siteZoneInput = (): string => envAlias.TZ ?? siteTimeZone(); /* MUTANT */",
    why: 'The textual process.env count never sees it: a second, unregistered reader of the zone (review, finding 3).',
  },
  {
    id: 'S2-xvii. ★★ a new read as process[\'env\'].NAME passes the ratchet',
    file: SITE,
    find: "export const siteZoneInput = (): string => siteTimeZone();",
    to: "export const siteZoneInput = (): string => process['env'].TZ ?? siteTimeZone(); /* MUTANT */",
    why: 'As S2-xvi, spelled with a string index.',
  },
  {
    id: 'S2-xviii. ★★★ a read\'s name is swapped for an unregistered one',
    file: ONSET,
    find: 'const ONSET_PATH = process.env.ALERT_ONSET_PATH',
    to: 'const ONSET_PATH = process.env.UNREGISTERED_NEW_KNOB /* MUTANT */',
    why: 'Occurrences, lines, files and the name count are all unchanged: only a pinned name set sees it.',
  },
  {
    id: 'S2-xix. ★★★ a new knob read through an existing dynamic-name helper',
    file: VITALS,
    find: "export const VITALS_LOAD_CRIT = num('VITALS_LOAD_CRIT', 6, 1, 128);",
    to: "export const VITALS_LOAD_CRIT = num('VITALS_LOAD_CRIT', 6, 1, 128);\nexport const VITALS_EXTRA_PROBE = num('VITALS_EXTRA_PROBE', 1, 0, 10); /* MUTANT */",
    why: 'The natural way to add a knob in that file: process.env[name] counts once however many names it reads.',
  },
  {
    id: 'S2-xx. ★★ a new read through import { env } from node:process',
    file: SITE,
    find: "export const siteZoneInput = (): string => siteTimeZone();",
    to: "import { env as envMod } from 'node:process'; export const siteZoneInput = (): string => envMod.TZ ?? siteTimeZone(); /* MUTANT */",
    why: 'As S2-xvi, through the module import.',
  },
  {
    id: 'S2-xxi. ★★★ the bridge accepts a second spelling of a schema-only export',
    file: BRIDGE,
    find: '        for (const line of strayReferences(runText, key)) {',
    to: '        for (const line of []) { /* MUTANT */',
    why: 'An indented, unquoted or assign-then-export line beside the has_value line exports "null" for a cleared field (TARIFF_PLAN=null fails closed; BENCH_SPARE_SNS=null replaces the spare literal).',
  },
  {
    id: 'S2-xxii. ★★ the bridge accepts a second copy of the has_value line',
    file: BRIDGE,
    find: '    if (line.trim() === canonical && !canonicalSeen) { canonicalSeen = true; continue; }',
    to: '    if (line.trim() === canonical) continue; /* MUTANT */',
    why: 'An indented copy inside another block reads as the canonical line: the rule names the line, not its count.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1191-s2', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
