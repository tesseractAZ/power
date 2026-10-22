#!/usr/bin/env node
/**
 * mutate-v1191-review3.mjs — v1.191.0, the third review's fixes (the night-charge per-night bound has
 * its own mutants in mutate-v1191-s6.mjs, N-*).
 *
 * What this guards:
 *   - the MPC tariff vector's fallback pair is the cost figures' own once TARIFF_PLAN is set (an
 *     unconfirmed two_tier plan priced at its two rates, not the 17 ¢ flat default), and the MPC's
 *     own pair while it is unset (golden G2);
 *   - the unconfirmed-rate on-peak fallback (onPeakAt) and the alert clock (fmtClock) are on the site
 *     clock, not the host's;
 *   - the process.env ratchet pins the names read through the three environment parameters;
 *   - the hardware facts in hwSpec.ts, and the pack-health alarm lines by behaviour;
 *   - OWNER DECISION 21: a new install ships BROADCAST_BILINGUAL off, declared;
 *   - the schema range of every key, the schema-only PV keys included, is its row's clamp and its parse;
 *   - a key is exported in one place, at the top level, above exec (the run script, run).
 *
 *   R3-mpc-idx          index.ts prices the MPC vector with the MPC names on every plan
 *   R3-mpc-planset      mpcFallbackPair ignores a set plan (two_tier priced at the flat default)
 *   R3-mpc-unset        mpcFallbackPair takes the cost figures' pair while TARIFF_PLAN is unset
 *   R3-onpeak-hour      onPeakAt reads the host's hour
 *   R3-onpeak-dow       onPeakAt reads the host's weekday
 *   R3-alert-clock      the gap and outage texts are written on the host clock
 *   R3-env-outage       a new knob read inside resolveOutageAlertOptions(env)
 *   R3-env-tui          a new knob read inside authFromEnv(env)
 *   R3-env-backup       resolveBackupJournalPath reads another name through its env
 *   R3-env-computed     a computed name read through an environment parameter
 *   R3-env-destructure  the environment parameter destructured
 *   R3-hw-circuits      SHP2_CIRCUIT_COUNT 12 → 11 (channel 12 dropped)
 *   R3-hw-nameplate     DPU_PACK_NAMEPLATE_WH 6144 → 6145
 *   R3-hw-guard         DPU_PACK_GUARD_WH 6200 → 6201
 *   R3-hw-soh-warn      SOH_WARN_PCT 85 → 86
 *   R3-hw-soh-crit      SOH_CRIT_PCT 75 → 76
 *   R3-soh-crit-le      the critical line includes 75 %
 *   R3-soh-warn-le      the warning line includes 85 %
 *   R3-bilingual        the shipped BROADCAST_BILINGUAL default is on again
 *   R3-bilingual-decl   the BROADCAST_BILINGUAL divergence is no longer declared
 *   R3-pv-kwp-min       the PV_ARRAY_KWP parse floor 0.1 → 0.5 (the schema still says 0.1)
 *   R3-pv-tilt-max      the PV_TILT_DEG parse ceiling 90 → 89
 *   R3-pv-az-max        the PV_AZIMUTH_DEG parse ceiling 360 → 359
 *   R3-pv-yaml          config.yaml narrows PV_TILT_DEG to 0-80 while the parse keeps 0-90
 *   R3-run-second       a second, later export of NOTIFY_CRITICAL_BYPASS_DND in the other convention
 *   R3-run-below-exec   a schema-only key's export moved below exec
 *   R3-run-nested       a schema-only key exported a second time inside another key's if-block
 *
 *   cd server && TSX_DISABLE_CACHE=1 MUTATE_CONCURRENCY=4 node ../scripts/mutate-v1191-review3.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = resolve(REPO, 'server/src/index.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const ALERTS = resolve(REPO, 'server/src/alerts.ts');
const SESSION = resolve(REPO, 'server/src/telnet/session.ts');
const BACKUP = resolve(REPO, 'server/src/backupWindow.ts');
const HW = resolve(REPO, 'server/src/hwSpec.ts');
const CONFIG = resolve(REPO, 'server/src/config.ts');
const YAML = resolve(REPO, 'ecoflow_panel/config.yaml');
const RUN = resolve(REPO, 'rootfs/etc/services.d/ecoflow-panel/run');
/** The run script's DEVICE_ALIASES line and everything after it, verbatim (R3-run-below-exec moves the line below exec). */
const ALIASES_LINE = "if bashio::config.has_value 'DEVICE_ALIASES'; then export DEVICE_ALIASES=\"$(bashio::config 'DEVICE_ALIASES')\"; fi\n";
const RUN_TAIL = '# SUPERVISOR_TOKEN is provided automatically by the HA Supervisor —\n# no need to export it manually. The Node process inherits it.\n\n'
  + 'bashio::log.info "Starting Power (ecoflow_panel) on :${PORT} (ssh ${SSH_ENABLED}:${SSH_PORT}, telnet alias ${TELNET_ENABLED}:${TELNET_PORT}, db ${DB_PATH})…"\n\n'
  + 'cd /app/server\nexec npm start\n';
const SUBSET = [
  'test/tariffPlan.test.ts',
  'test/siteClockFallback.test.ts',
  'test/processEnvRatchet.test.ts',
  'test/hwSpec.test.ts',
  'test/optionsDefaultParity.test.ts',
  'test/optionsEnvBridge.test.ts',
  'test/runScriptEnv.test.ts',
  'test/limits.test.ts',
  'test/pvSite.test.ts',
  'test/golden.test.ts',
];

const MUTANTS = [
  // ── the MPC vector's fallback pair (analytics.ts mpcFallbackPair) ──
  {
    id: 'R3-mpc-idx. ★★★ index.ts prices the MPC vector with the MPC names on every plan',
    file: IDX,
    find: '  const { onPeak, offPeak } = mpcFallbackPair(Date.now());',
    to: '  const { onPeak, offPeak } = legacyTariff.mpc; /* MUTANT */',
    why: 'An unconfirmed two_tier plan\'s MPC prices every hour at the 17 ¢ flat default while its cost figures use the plan\'s rates.',
  },
  {
    id: 'R3-mpc-planset. ★★★ mpcFallbackPair ignores a set plan',
    file: AN,
    find: '  if (!resolveTariffFromEnv().planSet) {',
    to: '  if (true as boolean) { /* MUTANT */',
    why: 'As R3-mpc-idx, inside the reader: the two_tier plan\'s 32/11 becomes 17/17 for the MPC only.',
  },
  {
    id: 'R3-mpc-unset. ★★★ mpcFallbackPair takes the cost figures\' pair while TARIFF_PLAN is unset',
    file: AN,
    find: '  if (!resolveTariffFromEnv().planSet) {',
    to: '  if (false as boolean) { /* MUTANT */',
    why: 'The reference install\'s MPC starts honouring TARIFF_ON_PEAK_CENTS (golden G2 pins that it does not).',
  },
  // ── the site clock ──
  {
    id: 'R3-onpeak-hour. ★★★ onPeakAt reads the host\'s hour',
    file: AN,
    find: '  const h = siteHour(ts);\n  const day = siteDow(ts);',
    to: '  const h = new Date(ts).getHours(); /* MUTANT */\n  const day = siteDow(ts);',
    why: 'A New York two_tier plan on a Phoenix host is priced on-peak 17:00-21:00 while its model says 14:00-19:00.',
  },
  {
    id: 'R3-onpeak-dow. ★★ onPeakAt reads the host\'s weekday',
    file: AN,
    find: '  const day = siteDow(ts);\n  const dow = day === 0 ? 7 : day;',
    to: '  const day = new Date(ts).getDay(); /* MUTANT */\n  const dow = day === 0 ? 7 : day;',
    why: 'A Tokyo site on a UTC host turns the weekday nine hours late: Monday\'s first hours are priced as Sunday\'s.',
  },
  {
    id: 'R3-alert-clock. ★★★ the gap and outage texts are written on the host clock',
    file: ALERTS,
    find: "toLocaleString('en-US', { timeZone: siteTimeZone(), month: 'short',",
    to: "toLocaleString('en-US', { month: 'short', /* MUTANT */",
    why: 'An outage at 14:00 in New York reads 11:00 AM on a Phoenix host, in the text and in Started / Ended.',
  },
  // ── the process.env ratchet: the names read through the three environment parameters ──
  {
    id: 'R3-env-outage. ★★★ a new knob read inside resolveOutageAlertOptions(env)',
    file: ALERTS,
    find: "    enabled: (env.SYSTEM_OUTAGE_ALERT_ENABLED ?? 'true') !== 'false',",
    to: "    enabled: (env.SYSTEM_OUTAGE_ALERT_ENABLED ?? env.UNREGISTERED_NEW_KNOB ?? 'true') !== 'false', /* MUTANT */",
    why: 'An environment knob with no OPTIONS row and no pin passes every gate (CA9: the ratchet must cover indirect readers).',
  },
  {
    id: 'R3-env-tui. ★★ a new knob read inside authFromEnv(env)',
    file: SESSION,
    find: "  const username = (env.TUI_USERNAME ?? '').trim() || 'operator';",
    to: "  const username = (env.TUI_USERNAME ?? env.UNREGISTERED_TUI_USER ?? '').trim() || 'operator'; /* MUTANT */",
    why: 'As R3-env-outage, in the console\'s credential reader.',
  },
  {
    id: 'R3-env-backup. ★★ resolveBackupJournalPath reads another name through its env',
    file: BACKUP,
    find: '  if (env.BACKUP_WINDOW_LOG) return env.BACKUP_WINDOW_LOG;',
    to: '  if (env.BACKUP_WINDOW_LOG_NEW) return env.BACKUP_WINDOW_LOG_NEW; /* MUTANT */',
    why: 'A renamed knob read through the parameter: the manifest no longer says what the file reads.',
  },
  {
    id: 'R3-env-computed. ★★ a computed name read through an environment parameter',
    file: ALERTS,
    find: '    minDurationMs: envNum(env.SYSTEM_OUTAGE_MIN_MINUTES, 15, 0) * 60_000,',
    to: "    minDurationMs: envNum(env[['SYSTEM_OUTAGE', 'MIN_MINUTES'].join('_')], 15, 0) * 60_000, /* MUTANT */",
    why: 'A name the scanner cannot read: any knob could hide behind it.',
  },
  {
    id: 'R3-env-destructure. ★★ the environment parameter destructured',
    file: ALERTS,
    find: 'export function resolveOutageAlertOptions(env: Record<string, string | undefined>): OutageAlertOptions {\n  return {',
    to: 'export function resolveOutageAlertOptions(env: Record<string, string | undefined>): OutageAlertOptions {\n  const { UNREGISTERED_D } = env; void UNREGISTERED_D; /* MUTANT */\n  return {',
    why: 'Names bound by destructuring are not pinned.',
  },
  // ── hwSpec.ts ──
  {
    id: 'R3-hw-circuits. ★★★ SHP2_CIRCUIT_COUNT 12 → 11',
    file: HW,
    find: 'export const SHP2_CIRCUIT_COUNT = 12;',
    to: 'export const SHP2_CIRCUIT_COUNT = 11; /* MUTANT */',
    why: 'Channel 12 vanishes from the projection, the dashboard and the circuit history.',
  },
  {
    id: 'R3-hw-nameplate. ★★ DPU_PACK_NAMEPLATE_WH 6144 → 6145',
    file: HW,
    find: 'export const DPU_PACK_NAMEPLATE_WH = 6144;',
    to: 'export const DPU_PACK_NAMEPLATE_WH = 6145; /* MUTANT */',
    why: 'The forecast band\'s last-resort pool size drifts from the pack nameplate.',
  },
  {
    id: 'R3-hw-guard. ★★ DPU_PACK_GUARD_WH 6200 → 6201',
    file: HW,
    find: 'export const DPU_PACK_GUARD_WH = 6200;',
    to: 'export const DPU_PACK_GUARD_WH = 6201; /* MUTANT */',
    why: 'The recorder\'s corrupt-read guard moves with no test noticing.',
  },
  {
    id: 'R3-hw-soh-warn. ★★★ SOH_WARN_PCT 85 → 86',
    file: HW,
    find: 'export const SOH_WARN_PCT = 85;',
    to: 'export const SOH_WARN_PCT = 86; /* MUTANT */',
    why: 'Every pack between 85 and 86 % SoH raises a degraded-health warning.',
  },
  {
    id: 'R3-hw-soh-crit. ★★★ SOH_CRIT_PCT 75 → 76',
    file: HW,
    find: 'export const SOH_CRIT_PCT = 75;',
    to: 'export const SOH_CRIT_PCT = 76; /* MUTANT */',
    why: 'A pack at 75.5 % SoH becomes a critical alarm.',
  },
  {
    id: 'R3-soh-crit-le. ★★ the critical line includes 75 %',
    file: ALERTS,
    find: '      if (soh != null && soh < SOH_CRIT_PCT) {',
    to: '      if (soh != null && soh <= SOH_CRIT_PCT) { /* MUTANT */',
    why: 'A pack at exactly 75 % is critical, not degraded.',
  },
  {
    id: 'R3-soh-warn-le. ★★ the warning line includes 85 %',
    file: ALERTS,
    find: '      } else if (soh != null && soh < SOH_WARN_PCT) {',
    to: '      } else if (soh != null && soh <= SOH_WARN_PCT) { /* MUTANT */',
    why: 'A pack at exactly 85 % warns.',
  },
  // ── OWNER DECISION 21 ──
  {
    id: 'R3-bilingual. ★★ the shipped BROADCAST_BILINGUAL default is on again',
    file: YAML,
    find: '  BROADCAST_BILINGUAL: false\n',
    to: '  BROADCAST_BILINGUAL: true # MUTANT\n',
    why: 'A new install inherits the reference home\'s Spanish pass (the approved decision undone).',
  },
  {
    id: 'R3-bilingual-decl. ★ the BROADCAST_BILINGUAL divergence is no longer declared',
    file: CONFIG,
    find: "  { key: 'BROADCAST_BILINGUAL', kind: 'unset', code: 'on', yaml: 'false',",
    to: "  { key: 'BROADCAST_BILINGUAL_X', kind: 'unset', code: 'on', yaml: 'false', /* MUTANT */",
    why: 'The absent-reads-as-on rule against a shipped off is silent again.',
  },
  // ── the schema range is the clamp and the parse, for the schema-only keys too ──
  {
    id: 'R3-pv-kwp-min. ★★ the PV_ARRAY_KWP parse floor 0.1 → 0.5',
    file: CONFIG,
    find: '    parse: floatOrNull(0.1, 500) }),',
    to: '    parse: floatOrNull(0.5, 500) }), /* MUTANT */',
    why: 'A 0.3 kWp array the schema accepts is held at 0.5.',
  },
  {
    id: 'R3-pv-tilt-max. ★★ the PV_TILT_DEG parse ceiling 90 → 89',
    file: CONFIG,
    find: "doc: 'PV array tilt from horizontal in degrees; unset keeps the reference tilt (25).', parse: floatOrNull(0, 90) }),",
    to: "doc: 'PV array tilt from horizontal in degrees; unset keeps the reference tilt (25).', parse: floatOrNull(0, 89) }), /* MUTANT */",
    why: 'A vertical (90°) array the schema accepts is held at 89.',
  },
  {
    id: 'R3-pv-az-max. ★★ the PV_AZIMUTH_DEG parse ceiling 360 → 359',
    file: CONFIG,
    find: "unset keeps 180.', parse: floatOrNull(0, 360) }),",
    to: "unset keeps 180.', parse: floatOrNull(0, 359) }), /* MUTANT */",
    why: 'The schema and the parse disagree at the top of the range.',
  },
  {
    id: 'R3-pv-yaml. ★★ config.yaml narrows PV_TILT_DEG to 0-80 while the parse keeps 0-90',
    file: YAML,
    find: '  PV_TILT_DEG: "float(0,90)?"',
    to: '  PV_TILT_DEG: "float(0,80)?" # MUTANT',
    why: 'Home Assistant refuses a steep array the code would take (the schema range is not the clamp).',
  },
  // ── the run script, run ──
  {
    id: 'R3-run-second. ★★★ a second, later export of NOTIFY_CRITICAL_BYPASS_DND in the other convention',
    file: RUN,
    find: 'cd /app/server\nexec npm start',
    to: 'export NOTIFY_CRITICAL_BYPASS_DND=false # MUTANT\ncd /app/server\nexec npm start',
    why: 'The later export wins in bash, and notify.ts reads `!== \'0\'`: the DND bypass is on whatever the option says.',
  },
  {
    id: 'R3-run-below-exec. ★★ a schema-only key\'s export moved below exec',
    file: RUN,
    find: ALIASES_LINE + RUN_TAIL,
    to: RUN_TAIL + ALIASES_LINE.replace(/\n$/, ' # MUTANT\n'),
    why: 'The line is still in the script, spelt as the rule wants, and never runs: DEVICE_ALIASES never reaches the server.',
  },
  {
    id: 'R3-run-nested. ★★ a schema-only key exported a second time inside another key\'s if-block',
    file: RUN,
    find: "  export NOTIFY_CRITICAL_BYPASS_DND=1\nelse",
    to: "  export NOTIFY_CRITICAL_BYPASS_DND=1\n  if bashio::config.has_value 'TARIFF_CURRENCY'; then export TARIFF_CURRENCY=\"$(bashio::config 'TARIFF_CURRENCY')\"; fi # MUTANT\nelse",
    why: 'A second, nested export of a key: it runs only while the DND bypass is on.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants (the goldens included).
await runMutantsParallel({ name: 'mutate-v1191-review3', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
