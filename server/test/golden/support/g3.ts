/**
 * G3 — parse parity: for each of the 85 add-on option keys, and for every value the run script
 * can export (absent, '', 'null', the shipped default, a valid non-default value, an invalid
 * value), what EVERY current reader of that key sees.
 *
 * A reader is probed one of three ways, named in `how`:
 *   - `call`   the real exported reader is called after process.env is set (per-call readers);
 *   - `import` the module is imported afresh with a cache-busting query so its module-level
 *              constant re-evaluates under the new environment;
 *   - `mirror` the reader is a private expression in a module that cannot be imported in a test
 *              (index.ts starts the server; alertMonitor's reads sit inside createAlertMonitor), so
 *              the expression is restated here. Every mirror carries a `cite` and an `anchor`: the
 *              cited source line must still contain the anchor text, or the probe fails loudly.
 *              When a lane moves that reader onto config.ts, the anchor fails, the probe is
 *              re-pointed at config, and the captured value must not change.
 *
 * v1.191.0 (S5) — a re-pointed probe keeps its reader id, its method and its citation: they are part of
 * the golden and record the tree it was captured on. `movedTo` names where the reader is now; that is
 * the anchor the capture checks, and `get` calls the moved reader.
 *
 * The table also records each key's run-script export convention (`exportForm`): the 1/0 and
 * true/false bool conventions coexist in the run script, and a reader parsed with the wrong one
 * inverts the option (the NOTIFY_CRITICAL_BYPASS_DND lesson).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDeclsCached as extractDecls } from './extract.js';
import { withEnv, type EnvPatch } from './env.js';
import { loadNotifyConfig, parsePushTargets } from '../../../src/notify.js';
import { loadBroadcastConfig } from '../../../src/broadcast.js';
import { parseQuietHours } from '../../../src/alertMonitor.js';
import { gridPresenceEntityId, floorSlackPct } from '../../../src/gridState.js';
import { hostPowerEntityId } from '../../../src/hostPower.js';
import { parseShedCandidates } from '../../../src/loadShedRegistry.js';
import { resolveChargeNowMode } from '../../../src/chargeNowResponder.js';
import { resolveNightChargeMode } from '../../../src/nightChargeActuator.js';
import { DEFAULT_COST_MAX_SOC_PCT, DEFAULT_OUTAGE_CUSHION_HOURS, DEFAULT_ISLANDED_LOAD_SAFETY } from '../../../src/nightChargeAdvisor.js';
import { planChargeCapKw } from '../../../src/nightForceCharge.js';
import { heartbeatIntervalMs } from '../../../src/heartbeat.js';
import { apsREvRatesFromEnv, positiveCents, tariffModelFromEnv } from '../../../src/tariff.js';
import { isNwsEnabled } from '../../../src/nws.js';
import { isMqttDiscoveryEnabled } from '../../../src/mqttDiscovery.js';
import { authFromEnv } from '../../../src/telnet/session.js';
import { resolveRetentionDays } from '../../../src/retention.js';
import { deviceReachabilityEntities } from '../../../src/deviceLink.js';
import { isWriteDebugEnabled } from '../../../src/ecoflow/commands.js';
import { bridgeSite } from '../../../src/energyBridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');

export type ExportForm = '1/0' | 'true/false' | 'verbatim';
export type How = 'call' | 'import' | 'mirror';

export interface Probe {
  /** Stable reader id, `file.ts:function` or `file.ts:line what`. */
  reader: string;
  how: How;
  /** For mirrors: the source file and an anchor substring that must be present. */
  cite?: { file: string; anchor: string };
  /** A derived quantity (pinned, but not a parse of the key itself): excluded from the OPTIONS comparison. */
  derived?: boolean;
  /** The reader moved after capture: the anchor checked instead of `cite` (which stays in the golden as captured). */
  movedTo?: { file: string; anchor: string };
  /**
   * v1.191.0 — set once the reader has moved onto its config.ts row: the anchor checked NOW (the
   * consumer's new line, which must read the row), while `cite` stays the line the golden was
   * captured from. The golden records `how`/`cite` as captured; the values are the contract.
   */
  anchorNow?: { file: string; anchor: string };
  get: (raw: string | undefined) => unknown | Promise<unknown>;
}

export interface KeySpec {
  key: string;
  exportForm: ExportForm;
  /** The run script's export of the shipped `options:` default. */
  def: string;
  valid: string;
  invalid: string;
  /** Extra variants beyond the standard six. */
  extra?: Record<string, string>;
  /** Other variables that must be set for the probes to be meaningful. */
  context?: EnvPatch;
  probes: Probe[];
}

const E = (k: string) => process.env[k];
let importSeq = 0;
async function fresh<T>(rel: string): Promise<T> {
  importSeq += 1;
  return (await import(`../../../src/${rel}?g3=${importSeq}`)) as T;
}
type Cfg = typeof import('../../../src/config.js');
import { option } from '../../../src/config.js';

const mirror = (reader: string, file: string, anchor: string, get: Probe['get']): Probe => ({ reader, how: 'mirror', cite: { file, anchor }, get });
const call = (reader: string, get: Probe['get']): Probe => ({ reader, how: 'call', get });
const imp = (reader: string, get: Probe['get']): Probe => ({ reader, how: 'import', get });
const derived = (p: Probe): Probe => ({ ...p, derived: true });
/**
 * v1.191.0 — a mirrored reader that a lane moved onto config.ts: the probe now reads the OPTIONS row
 * the consumer reads (`option(key)`), and `now` must be present in the consumer's file, so the probe
 * still fails loudly if the consumer stops reading the row. The captured values must not change.
 */
const movedToRow = (p: Probe, key: string, now: { file: string; anchor: string }): Probe =>
  ({ ...p, anchorNow: now, get: () => option(key) });

const notFalse = (k: string, reader: string, file: string, anchor: string) => mirror(reader, file, anchor, () => E(k) !== 'false');
const trueOr1 = (k: string, reader: string, file: string, anchor: string) => mirror(reader, file, anchor, () => E(k) === 'true' || E(k) === '1');
const numOr = (k: string, d: number, reader: string, file: string, anchor: string) => mirror(reader, file, anchor, () => Number(E(k) ?? d));

const credential = (key: string): KeySpec => ({
  key, exportForm: 'verbatim', def: '', valid: 'k_abc123', invalid: '0',
  probes: [imp('config.ts:lazyRequired', async () => {
    const { config } = await fresh<Cfg>('config.ts');
    try { return key === 'ECOFLOW_ACCESS_KEY' ? config.accessKey : config.secretKey; }
    catch (e) { return { throws: (e as Error).message }; }
  })],
});

const cent = (key: string, field: (r: ReturnType<typeof apsREvRatesFromEnv>) => number | null | undefined): KeySpec => ({
  key, exportForm: 'verbatim', def: '', valid: '12.59', invalid: 'abc', extra: { zero: '0', negative: '-1' },
  probes: [
    call('tariff.ts:apsREvRatesFromEnv', () => field(apsREvRatesFromEnv())),
    // v1.191.0 (S5, R6) — re-pointed: the cost-figure path reads this cent from the model (any finite
    // value, apsREvRatesFromEnv) and keeps its above-zero rule (positiveCents); apsCent is gone.
    { reader: 'analytics.ts:apsCent', how: 'import', get: () => positiveCents(field(apsREvRatesFromEnv())) },
  ],
});

const broadcastField = (field: keyof ReturnType<typeof loadBroadcastConfig>) => call('broadcast.ts:loadBroadcastConfig', () => loadBroadcastConfig()[field]);
const notifyField = (field: keyof ReturnType<typeof loadNotifyConfig>) => call('notify.ts:loadNotifyConfig', () => loadNotifyConfig()[field]);

export const KEYS: KeySpec[] = [
  credential('ECOFLOW_ACCESS_KEY'),
  credential('ECOFLOW_SECRET_KEY'),
  { key: 'ECOFLOW_API_HOST', exportForm: 'verbatim', def: 'https://api-a.ecoflow.com', valid: 'https://api-e.ecoflow.com', invalid: 'not a url',
    probes: [imp('config.ts:apiHost', async () => (await fresh<Cfg>('config.ts')).config.apiHost)] },
  { key: 'LOG_LEVEL', exportForm: 'verbatim', def: 'info', valid: 'debug', invalid: 'loud',
    probes: [imp('config.ts:logLevel', async () => (await fresh<Cfg>('config.ts')).config.logLevel)] },
  { key: 'FORECAST_LAT', exportForm: 'verbatim', def: '33.4484', valid: '52.52', invalid: 'abc', extra: { outOfRange: '91' },
    probes: [
      imp('config.ts:forecastLat', async () => (await fresh<Cfg>('config.ts')).config.forecastLat),
      derived(imp('energyBridge.ts:bridgeSite', async () => bridgeSite((await fresh<Cfg>('config.ts')).config))),
    ] },
  { key: 'FORECAST_LON', exportForm: 'verbatim', def: '-112.074', valid: '13.405', invalid: 'abc', extra: { outOfRange: '181' },
    probes: [
      imp('config.ts:forecastLon', async () => (await fresh<Cfg>('config.ts')).config.forecastLon),
      derived(imp('energyBridge.ts:bridgeSite', async () => bridgeSite((await fresh<Cfg>('config.ts')).config))),
    ] },
  { key: 'NOTIFY_CHANNEL', exportForm: 'verbatim', def: 'none', valid: 'ha', invalid: 'ntfy', extra: { upper: 'HA' }, probes: [notifyField('channel')] },
  { key: 'NOTIFY_MIN_SEVERITY', exportForm: 'verbatim', def: 'warning', valid: 'critical', invalid: 'info', extra: { upper: 'CRITICAL' }, probes: [notifyField('minSeverity')] },
  { key: 'NOTIFY_RESOLVED', exportForm: '1/0', def: '1', valid: '0', invalid: 'false', probes: [notifyField('notifyResolved')] },
  { key: 'NOTIFY_HA_PUSH_TARGETS', exportForm: 'verbatim', def: '', valid: 'notify.mobile_app_phone, notify.notify', invalid: 'bad target!',
    probes: [notifyField('pushTargets'), call('notify.ts:parsePushTargets', (raw) => parsePushTargets(raw))] },
  { key: 'NOTIFY_CRITICAL_BYPASS_DND', exportForm: '1/0', def: '1', valid: '0', invalid: 'false', probes: [notifyField('criticalBypassDnd')] },
  { key: 'NOTIFY_QUIET_HOURS', exportForm: 'verbatim', def: '22-06', valid: '23-05', invalid: '25-99',
    probes: [
      movedToRow(mirror('alertMonitor.ts:2650 QUIET_WINDOW', 'alertMonitor.ts', "parseQuietHours(process.env.NOTIFY_QUIET_HOURS ?? '22-06')", () => parseQuietHours(E('NOTIFY_QUIET_HOURS') ?? '22-06')),
        'NOTIFY_QUIET_HOURS', { file: 'alertMonitor.ts', anchor: "const QUIET_WINDOW = option<[number, number] | null>('NOTIFY_QUIET_HOURS');" }),
      mirror('index.ts:5022 DRIFT_QUIET', 'index.ts', "parseNotifyQuiet(process.env.NOTIFY_QUIET_HOURS ?? '22-06')", () => parseQuietHours(E('NOTIFY_QUIET_HOURS') ?? '22-06')),
      derived(mirror('index.ts:2699 quietConfigured', 'index.ts', "(process.env.NOTIFY_QUIET_HOURS ?? '').trim() !== ''", () => (E('NOTIFY_QUIET_HOURS') ?? '').trim() !== '')),
    ] },
  { key: 'NOTIFY_DIGEST_HOUR', exportForm: 'verbatim', def: '7', valid: '9', invalid: 'abc', extra: { outOfRange: '25' },
    probes: [movedToRow(numOr('NOTIFY_DIGEST_HOUR', 7, 'alertMonitor.ts:2656 DIGEST_HOUR', 'alertMonitor.ts', 'Number(process.env.NOTIFY_DIGEST_HOUR ?? 7)'),
      'NOTIFY_DIGEST_HOUR', { file: 'alertMonitor.ts', anchor: "const DIGEST_HOUR = option<number>('NOTIFY_DIGEST_HOUR');" })] },
  { key: 'BROADCAST_ENABLED', exportForm: 'true/false', def: 'false', valid: 'true', invalid: '0', extra: { one: '1' },
    probes: [broadcastField('enabled'), trueOr1('BROADCAST_ENABLED', 'index.ts:6323 envEnabled', 'index.ts', "process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1'")] },
  { key: 'BROADCAST_TARGETS', exportForm: 'verbatim', def: '', valid: 'media_player.kitchen, media_player.den', invalid: 'kitchen', probes: [broadcastField('targets')] },
  { key: 'BROADCAST_SIP_TARGETS', exportForm: 'verbatim', def: '', valid: 'media_player.cordless', invalid: 'cordless', probes: [broadcastField('sipTargets')] },
  { key: 'BROADCAST_MIN_SEVERITY', exportForm: 'verbatim', def: 'critical', valid: 'warning', invalid: 'info', probes: [broadcastField('minSeverity')] },
  { key: 'BROADCAST_QUIET_HOURS', exportForm: 'verbatim', def: '22-06', valid: '23-05', invalid: '25-99',
    probes: [broadcastField('quietHours'), derived(mirror('index.ts:2699 quietConfigured', 'index.ts', "(process.env.BROADCAST_QUIET_HOURS ?? '').trim() !== ''", () => (E('BROADCAST_QUIET_HOURS') ?? '').trim() !== ''))] },
  { key: 'CRITICAL_BREAKS_QUIET_HOURS', exportForm: 'true/false', def: 'false', valid: 'true', invalid: '0', extra: { one: '1' },
    probes: [
      broadcastField('criticalBreakThrough'),
      movedToRow(trueOr1('CRITICAL_BREAKS_QUIET_HOURS', 'alertMonitor.ts:2655 CRITICAL_BREAKS_QUIET', 'alertMonitor.ts', "process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1'"),
        'CRITICAL_BREAKS_QUIET_HOURS', { file: 'alertMonitor.ts', anchor: "const CRITICAL_BREAKS_QUIET = option<boolean>('CRITICAL_BREAKS_QUIET_HOURS');" }),
      trueOr1('CRITICAL_BREAKS_QUIET_HOURS', 'index.ts:2697 critBreaks', 'index.ts', "process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1'"),
    ] },
  { key: 'BROADCAST_AUDIO_BASE', exportForm: 'verbatim', def: 'http://homeassistant.local:8787', valid: 'http://power.example:8787/', invalid: ' ', probes: [broadcastField('audioBase')] },
  { key: 'BROADCAST_VOLUME', exportForm: 'verbatim', def: '0.5', valid: '0.7', invalid: 'abc', extra: { outOfRange: '1.5' },
    probes: [
      broadcastField('volume'),
      mirror('index.ts:6324 envVolume', 'index.ts', 'Number(process.env.BROADCAST_VOLUME ?? 0.5)', () => { const n = Number(E('BROADCAST_VOLUME') ?? 0.5); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }),
    ] },
  { key: 'BROADCAST_ANNOUNCE_VOLUME', exportForm: 'verbatim', def: '', valid: '80', invalid: 'loud', extra: { standing: 'standing', outOfRange: '150' },
    probes: [broadcastField('announceVolume'), derived(mirror('index.ts:6326 announceVolumePinned', 'index.ts', "(process.env.BROADCAST_ANNOUNCE_VOLUME ?? '').trim().length > 0", () => (E('BROADCAST_ANNOUNCE_VOLUME') ?? '').trim().length > 0))] },
  { key: 'BROADCAST_USE_PRE_ANNOUNCE', exportForm: 'true/false', def: 'false', valid: 'true', invalid: '0', extra: { one: '1' }, probes: [broadcastField('usePreAnnounce')] },
  { key: 'BROADCAST_LEAD_SILENCE_MS', exportForm: 'verbatim', def: '1000', valid: '1500', invalid: 'abc', extra: { outOfRange: '9000', decimal: '1200.6' }, probes: [broadcastField('leadSilenceMs')] },
  { key: 'BROADCAST_REPEAT', exportForm: 'verbatim', def: '2', valid: '3', invalid: 'abc', extra: { outOfRange: '9' }, probes: [broadcastField('repeat')] },
  { key: 'BROADCAST_REPEAT_GAP_MS', exportForm: 'verbatim', def: '1500', valid: '2000', invalid: 'abc', extra: { outOfRange: '9000' }, probes: [broadcastField('repeatGapMs')] },
  { key: 'BROADCAST_CHIME_GAP_MS', exportForm: 'verbatim', def: '1000', valid: '500', invalid: 'abc', extra: { outOfRange: '-5' }, probes: [broadcastField('chimeGapMs')] },
  { key: 'BROADCAST_ANNOUNCE_RETRIES', exportForm: 'verbatim', def: '1', valid: '3', invalid: 'abc', extra: { outOfRange: '7' }, probes: [broadcastField('announceRetries')] },
  { key: 'BROADCAST_WYOMING_HOST', exportForm: 'verbatim', def: 'core-piper', valid: 'piper.example', invalid: ' ', probes: [broadcastField('wyomingHost')] },
  { key: 'BROADCAST_WYOMING_PORT', exportForm: 'verbatim', def: '10200', valid: '10300', invalid: 'abc', extra: { zero: '0' }, probes: [broadcastField('wyomingPort')] },
  { key: 'BROADCAST_WYOMING_VOICE', exportForm: 'verbatim', def: '', valid: 'en_US-amy-medium', invalid: '  ', probes: [broadcastField('wyomingVoice')] },
  // v1.191.0 (OWNER DECISION 21) — `def` stays 'true', the value the reference install stores (the golden pins
  // its behaviour); the shipped `options:` default is now 'false', which the 'valid' variant covers.
  { key: 'BROADCAST_BILINGUAL', exportForm: 'true/false', def: 'true', valid: 'false', invalid: 'no', extra: { zero: '0' }, probes: [broadcastField('bilingual')] },
  { key: 'BROADCAST_WYOMING_VOICE_ES', exportForm: 'verbatim', def: '', valid: ' es_MX-claude-high ', invalid: '  ', probes: [broadcastField('secondLangVoice')] },
  { key: 'BATTERY_SOC_ALARM_ENABLED', exportForm: 'true/false', def: 'true', valid: 'false', invalid: '0',
    probes: [notFalse('BATTERY_SOC_ALARM_ENABLED', 'index.ts:2500 socAlarmEnabled', 'index.ts', "process.env.BATTERY_SOC_ALARM_ENABLED !== 'false'")] },
  { key: 'BATTERY_RUNWAY_ALARM_ENABLED', exportForm: 'true/false', def: 'true', valid: 'false', invalid: '0',
    probes: [notFalse('BATTERY_RUNWAY_ALARM_ENABLED', 'index.ts:2524 runwayAlarmEnabled', 'index.ts', "process.env.BATTERY_RUNWAY_ALARM_ENABLED !== 'false'")] },
  { key: 'BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN', exportForm: 'verbatim', def: '60', valid: '120', invalid: 'abc', extra: { belowFloor: '0', outOfRange: '800' },
    probes: [imp('runwayAlarm.ts:RUNWAY_ALARM_REANNOUNCE_MS', async () => (await fresh<typeof import('../../../src/runwayAlarm.js')>('runwayAlarm.ts')).RUNWAY_ALARM_REANNOUNCE_MS)] },
  { key: 'GRID_AVAILABLE', exportForm: 'true/false', def: 'false', valid: 'true', invalid: '1',
    probes: [
      mirror('gridState.ts:633 gridAvailableFallback', 'gridState.ts', "gridAvailableFallback: process.env.GRID_AVAILABLE === 'true'", () => E('GRID_AVAILABLE') === 'true'),
      mirror('index.ts:2123 gridAvailable', 'index.ts', "const gridAvailable = process.env.GRID_AVAILABLE === 'true'", () => E('GRID_AVAILABLE') === 'true'),
      derived(mirror('index.ts:2695 offGrid', 'index.ts', "process.env.GRID_AVAILABLE !== 'true' && gridPresenceEntityId() === ''", () => E('GRID_AVAILABLE') !== 'true' && gridPresenceEntityId() === '')),
    ] },
  { key: 'GRID_PRESENCE_ENTITY', exportForm: 'verbatim', def: '', valid: ' binary_sensor.grid ', invalid: '  ', probes: [call('gridState.ts:gridPresenceEntityId', () => gridPresenceEntityId())] },
  { key: 'GRID_FLOOR_SLACK_PCT', exportForm: 'verbatim', def: '1.5', valid: '2.5', invalid: 'abc', extra: { outOfRange: '12', negative: '-1' }, probes: [call('gridState.ts:floorSlackPct', () => floorSlackPct())] },
  { key: 'CHARGE_NOW_RESPONSE', exportForm: 'verbatim', def: 'advisory', valid: 'supervised', invalid: 'auto', extra: { off: 'off' },
    probes: [mirror('index.ts:4922 CHARGE_NOW_MODE', 'index.ts', 'resolveChargeNowMode(process.env.CHARGE_NOW_RESPONSE)', () => resolveChargeNowMode(E('CHARGE_NOW_RESPONSE')))] },
  { key: 'HOST_POWER_ENTITY', exportForm: 'verbatim', def: '', valid: ' binary_sensor.pi_undervoltage ', invalid: '  ', probes: [call('hostPower.ts:hostPowerEntityId', () => hostPowerEntityId())] },
  { key: 'LOAD_SHEDDING_ADVISORY_ENABLED', exportForm: 'true/false', def: 'true', valid: 'false', invalid: '0',
    probes: [notFalse('LOAD_SHEDDING_ADVISORY_ENABLED', 'index.ts:2715 loadShedAdvisoryEnabled', 'index.ts', "process.env.LOAD_SHEDDING_ADVISORY_ENABLED !== 'false'")] },
  { key: 'LOAD_SHEDDING_SHED_ENTITIES', exportForm: 'verbatim', def: '', valid: 'switch.pool_pump:1:Pool pump:1800:3, switch.heater:2::4500', invalid: 'nodot',
    probes: [call('loadShedRegistry.ts:parseShedCandidates', (raw) => parseShedCandidates(raw))] },
  { key: 'LOAD_SHEDDING_RUNWAY_THRESHOLD_H', exportForm: 'verbatim', def: '4.0', valid: '6.5', invalid: 'abc', extra: { intShaped: '4' },
    probes: [numOr('LOAD_SHEDDING_RUNWAY_THRESHOLD_H', 4.0, 'index.ts:2727 thresholdHours', 'index.ts', 'Number(process.env.LOAD_SHEDDING_RUNWAY_THRESHOLD_H ?? 4.0)')] },
  { key: 'LOAD_SHEDDING_RESTORE_MARGIN_H', exportForm: 'verbatim', def: '2.0', valid: '3.5', invalid: 'abc', extra: { intShaped: '2' },
    probes: [numOr('LOAD_SHEDDING_RESTORE_MARGIN_H', 2.0, 'index.ts:2728 restoreMarginHours', 'index.ts', 'Number(process.env.LOAD_SHEDDING_RESTORE_MARGIN_H ?? 2.0)')] },
  { key: 'NIGHT_CHARGE_ADVISOR_ENABLED', exportForm: 'true/false', def: 'true', valid: 'false', invalid: '0',
    probes: [notFalse('NIGHT_CHARGE_ADVISOR_ENABLED', 'index.ts:3126 nightChargeEnabled', 'index.ts', "process.env.NIGHT_CHARGE_ADVISOR_ENABLED !== 'false'")] },
  { key: 'NIGHT_CHARGE_MODE', exportForm: 'verbatim', def: 'advisory', valid: 'supervised', invalid: 'Auto', extra: { auto: 'auto' },
    probes: [mirror('index.ts:3142 NIGHT_CHARGE_MODE', 'index.ts', 'resolveNightChargeMode(process.env.NIGHT_CHARGE_MODE)', () => resolveNightChargeMode(E('NIGHT_CHARGE_MODE')))] },
  { key: 'ARB_OUTAGE_CUSHION_PCT', exportForm: 'verbatim', def: '15', valid: '20', invalid: 'abc', extra: { outOfRange: '45' },
    probes: [movedToRow(numOr('ARB_OUTAGE_CUSHION_PCT', 15, 'index.ts:3422 cushionPct', 'index.ts', 'Number(process.env.ARB_OUTAGE_CUSHION_PCT ?? 15)'),
      'ARB_OUTAGE_CUSHION_PCT', { file: 'index.ts', anchor: "const cushionPct = option<number>('ARB_OUTAGE_CUSHION_PCT');" })] },
  { key: 'ARB_OUTAGE_CUSHION_HOURS', exportForm: 'verbatim', def: '4', valid: '6', invalid: 'abc', extra: { zero: '0' },
    probes: [movedToRow(numOr('ARB_OUTAGE_CUSHION_HOURS', DEFAULT_OUTAGE_CUSHION_HOURS, 'index.ts:3426 outageCushionHours', 'index.ts', 'Number(process.env.ARB_OUTAGE_CUSHION_HOURS ?? DEFAULT_OUTAGE_CUSHION_HOURS)'),
      'ARB_OUTAGE_CUSHION_HOURS', { file: 'index.ts', anchor: "const outageCushionHours = option<number>('ARB_OUTAGE_CUSHION_HOURS');" })] },
  { key: 'ARB_ISLANDED_LOAD_SAFETY', exportForm: 'verbatim', def: '1.25', valid: '1.5', invalid: 'abc',
    probes: [movedToRow(numOr('ARB_ISLANDED_LOAD_SAFETY', DEFAULT_ISLANDED_LOAD_SAFETY, 'index.ts:3432 islandedLoadSafety', 'index.ts', 'Number(process.env.ARB_ISLANDED_LOAD_SAFETY ?? DEFAULT_ISLANDED_LOAD_SAFETY)'),
      'ARB_ISLANDED_LOAD_SAFETY', { file: 'index.ts', anchor: "const islandedLoadSafety = option<number>('ARB_ISLANDED_LOAD_SAFETY');" })] },
  { key: 'ARB_OBJECTIVE', exportForm: 'verbatim', def: 'resilience', valid: 'cost', invalid: 'profit', extra: { upper: 'COST' },
    probes: [
      movedToRow(mirror('index.ts:3146 FORCE_CHARGE_OBJECTIVE', 'index.ts', "(process.env.ARB_OBJECTIVE ?? 'resilience').toLowerCase() === 'cost' ? 'cost' as const : 'resilience' as const", () => (E('ARB_OBJECTIVE') ?? 'resilience').toLowerCase() === 'cost' ? 'cost' : 'resilience'),
        'ARB_OBJECTIVE', { file: 'index.ts', anchor: "const FORCE_CHARGE_OBJECTIVE = option<'cost' | 'resilience'>('ARB_OBJECTIVE');" }),
    ] },
  { key: 'ARB_COST_MAX_SOC_PCT', exportForm: 'verbatim', def: '90', valid: '80', invalid: 'abc', extra: { belowFloor: '50' },
    probes: [movedToRow(numOr('ARB_COST_MAX_SOC_PCT', DEFAULT_COST_MAX_SOC_PCT, 'index.ts:3147 FORCE_CHARGE_COST_MAX_SOC_PCT', 'index.ts', 'Number(process.env.ARB_COST_MAX_SOC_PCT ?? DEFAULT_COST_MAX_SOC_PCT)'),
      'ARB_COST_MAX_SOC_PCT', { file: 'index.ts', anchor: "const FORCE_CHARGE_COST_MAX_SOC_PCT = option<number>('ARB_COST_MAX_SOC_PCT');" })] },
  { key: 'ARB_MIN_BUY_KWH', exportForm: 'verbatim', def: '1', valid: '2.5', invalid: 'abc',
    probes: [movedToRow(numOr('ARB_MIN_BUY_KWH', 1, 'index.ts:3505 minBuyKwh', 'index.ts', 'Number(process.env.ARB_MIN_BUY_KWH ?? 1)'),
      'ARB_MIN_BUY_KWH', { file: 'index.ts', anchor: "const minBuyKwh = option<number>('ARB_MIN_BUY_KWH');" })] },
  { key: 'ARB_CHARGE_CAP_KW', exportForm: 'verbatim', def: '0', valid: '12', invalid: 'abc', extra: { negative: '-1' },
    probes: [
      movedToRow(numOr('ARB_CHARGE_CAP_KW', 0, 'index.ts:3437 chargeCapKw', 'index.ts', 'Number(process.env.ARB_CHARGE_CAP_KW ?? 0)'),
        'ARB_CHARGE_CAP_KW', { file: 'index.ts', anchor: "planChargeCapKw(option<number>('ARB_CHARGE_CAP_KW'), planConnectedSlots, legEff)" }),
      derived(call('nightForceCharge.ts:planChargeCapKw', () => planChargeCapKw(Number(E('ARB_CHARGE_CAP_KW') ?? 0), 3, Math.sqrt(0.86)))),
    ] },
  { key: 'ARB_GRID_INPUT_CAP_KW', exportForm: 'verbatim', def: '17', valid: '19', invalid: 'abc', extra: { zero: '0' },
    probes: [movedToRow(mirror('index.ts:5334 gridInputCapKwFromEnv', 'index.ts', 'const raw = Number(process.env.ARB_GRID_INPUT_CAP_KW ?? 17);', () => { const raw = Number(E('ARB_GRID_INPUT_CAP_KW') ?? 17); return Number.isFinite(raw) && raw > 0 ? raw : null; }),
      'ARB_GRID_INPUT_CAP_KW', { file: 'index.ts', anchor: "  return option<number | null>('ARB_GRID_INPUT_CAP_KW');" })] },
  { key: 'ARB_LOAD_P90_FACTOR', exportForm: 'verbatim', def: '1.15', valid: '1.3', invalid: 'abc',
    probes: [movedToRow(numOr('ARB_LOAD_P90_FACTOR', 1.15, 'index.ts:3451 loadBandFloor', 'index.ts', 'Number(process.env.ARB_LOAD_P90_FACTOR ?? 1.15)'),
      'ARB_LOAD_P90_FACTOR', { file: 'index.ts', anchor: "const loadBandFloor = option<number>('ARB_LOAD_P90_FACTOR');" })] },
  { key: 'NIGHT_CHARGE_NOTIFY_HOUR', exportForm: 'verbatim', def: '21', valid: '20', invalid: 'abc', extra: { clamped: '23', decimal: '7.6' },
    probes: [{ reader: 'index.ts:3131 NIGHT_CHARGE_NOTIFY_HOUR', how: 'mirror', cite: { file: 'index.ts', anchor: 'clampInt(Number(process.env.NIGHT_CHARGE_NOTIFY_HOUR ?? 21), 0, 22, 21)' },
      get: async () => (await extractDecls<{ clampInt(v: number, lo: number, hi: number, d: number): number }>(resolve(SRC, 'index.ts'), ['clampInt'])).clampInt(Number(E('NIGHT_CHARGE_NOTIFY_HOUR') ?? 21), 0, 22, 21) }] },
  { key: 'NIGHT_CHARGE_NOTIFY_MINUTE', exportForm: 'verbatim', def: '30', valid: '0', invalid: 'abc', extra: { clamped: '75', decimal: '29.5' },
    probes: [{ reader: 'index.ts:3132 NIGHT_CHARGE_NOTIFY_MINUTE', how: 'mirror', cite: { file: 'index.ts', anchor: 'clampInt(Number(process.env.NIGHT_CHARGE_NOTIFY_MINUTE ?? 30), 0, 59, 30)' },
      get: async () => (await extractDecls<{ clampInt(v: number, lo: number, hi: number, d: number): number }>(resolve(SRC, 'index.ts'), ['clampInt'])).clampInt(Number(E('NIGHT_CHARGE_NOTIFY_MINUTE') ?? 30), 0, 59, 30) }] },
  { key: 'NIGHT_CHARGE_NOTIFY_ON_HOLD', exportForm: 'true/false', def: 'true', valid: 'false', invalid: '0',
    probes: [notFalse('NIGHT_CHARGE_NOTIFY_ON_HOLD', 'index.ts:4544 notifyOnHold', 'index.ts', "process.env.NIGHT_CHARGE_NOTIFY_ON_HOLD !== 'false'")] },
  { key: 'HEARTBEAT_URL', exportForm: 'verbatim', def: '', valid: 'https://hc.example/ping/abc', invalid: 'ftp://x',
    probes: [
      mirror('heartbeat.ts:183 urlConfigured', 'heartbeat.ts', "st.urlConfigured = (raw ?? '').trim() !== '';", () => (E('HEARTBEAT_URL') ?? '').trim() !== ''),
      derived({ reader: 'heartbeat.ts:parseHeartbeatUrl', how: 'import', get: async () => (await extractDecls<{ parseHeartbeatUrl(r: string | undefined): unknown }>(resolve(SRC, 'heartbeat.ts'), ['parseHeartbeatUrl'])).parseHeartbeatUrl(E('HEARTBEAT_URL')) }),
    ] },
  { key: 'HEARTBEAT_INTERVAL_S', exportForm: 'verbatim', def: '300', valid: '600', invalid: 'abc', extra: { outOfRange: '99999', belowFloor: '10' },
    probes: [call('heartbeat.ts:heartbeatIntervalMs', (raw) => heartbeatIntervalMs(raw))] },
  cent('TARIFF_APS_ONPEAK_SUMMER_CENTS', (r) => r.onPeak?.summer),
  cent('TARIFF_APS_ONPEAK_WINTER_CENTS', (r) => r.onPeak?.winter),
  cent('TARIFF_APS_OFFPEAK_SUMMER_CENTS', (r) => r.offPeak?.summer),
  cent('TARIFF_APS_OFFPEAK_WINTER_CENTS', (r) => r.offPeak?.winter),
  cent('TARIFF_APS_OVERNIGHT_CENTS', (r) => r.overnight?.summer),
  cent('TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS', (r) => r.superOffPeak?.winter),
  { key: 'TARIFF_APS_RATES_CONFIRMED', exportForm: 'true/false', def: 'false', valid: 'true', invalid: '1',
    probes: [
      call('tariff.ts:apsREvRatesFromEnv', () => apsREvRatesFromEnv().confirmed),
      // v1.191.0 (S5, R6) — moved: resolveTariffCents asks the model of the plan in effect whether its rates
      // are confirmed (TARIFF_APS_RATES_CONFIRMED while TARIFF_RATES_CONFIRMED is unset).
      { ...mirror('analytics.ts:8859 resolveTariffCents', 'analytics.ts', "if (process.env.TARIFF_APS_RATES_CONFIRMED === 'true') {", () => tariffModelFromEnv().ratesConfirmed),
        movedTo: { file: 'analytics.ts', anchor: '  if (model.ratesConfirmed) {\n    const pair = twoTierPairOf(model, nowMs);' } },
    ] },
  { key: 'NWS_ENABLED', exportForm: '1/0', def: '0', valid: '1', invalid: 'yes', extra: { trueWord: 'TRUE' }, probes: [call('nws.ts:isNwsEnabled', () => isNwsEnabled())] },
  { key: 'MQTT_DISCOVERY_ENABLED', exportForm: '1/0', def: '0', valid: '1', invalid: 'yes', extra: { trueWord: 'True' }, context: { MQTT_DISCOVERY_HOST: 'broker.example' },
    probes: [call('mqttDiscovery.ts:isMqttDiscoveryEnabled', () => isMqttDiscoveryEnabled())] },
  { key: 'MQTT_DISCOVERY_HOST', exportForm: 'verbatim', def: '', valid: 'broker.example', invalid: ' ', context: { MQTT_DISCOVERY_ENABLED: '1' },
    probes: [call('mqttDiscovery.ts:isMqttDiscoveryEnabled', () => isMqttDiscoveryEnabled()), mirror('mqttDiscovery.ts:1145 host', 'mqttDiscovery.ts', 'const host = process.env.MQTT_DISCOVERY_HOST!;', () => E('MQTT_DISCOVERY_HOST'))] },
  { key: 'MQTT_DISCOVERY_PORT', exportForm: 'verbatim', def: '1883', valid: '8883', invalid: 'abc', probes: [numOr('MQTT_DISCOVERY_PORT', 1883, 'mqttDiscovery.ts:1146 port', 'mqttDiscovery.ts', 'Number(process.env.MQTT_DISCOVERY_PORT ?? 1883)')] },
  { key: 'MQTT_DISCOVERY_USER', exportForm: 'verbatim', def: '', valid: 'mqtt_user', invalid: ' ', probes: [mirror('mqttDiscovery.ts:1147 user', 'mqttDiscovery.ts', 'const user = process.env.MQTT_DISCOVERY_USER;', () => E('MQTT_DISCOVERY_USER'))] },
  { key: 'MQTT_DISCOVERY_PASS', exportForm: 'verbatim', def: '', valid: 'secret', invalid: ' ', probes: [mirror('mqttDiscovery.ts:1148 pass', 'mqttDiscovery.ts', 'const pass = process.env.MQTT_DISCOVERY_PASS;', () => E('MQTT_DISCOVERY_PASS'))] },
  { key: 'MQTT_DISCOVERY_PREFIX', exportForm: 'verbatim', def: 'homeassistant', valid: 'ha', invalid: ' ', probes: [mirror('mqttDiscovery.ts:1149 prefix', 'mqttDiscovery.ts', "const prefix = process.env.MQTT_DISCOVERY_PREFIX ?? 'homeassistant';", () => E('MQTT_DISCOVERY_PREFIX') ?? 'homeassistant')] },
  // v1.190.0 — the console is served over SSH; SSH_ENABLED / SSH_PORT are the options and TELNET_ENABLED /
  // TELNET_PORT their deprecated aliases, all four resolved together by config.ts resolveSshConfig. Each key
  // is probed with its partner at the shipped default (the run script always exports both), so the golden
  // shows that key's own contribution; the alias matrix itself is sshConfig.test.ts.
  { key: 'SSH_ENABLED', exportForm: '1/0', def: '0', valid: '1', invalid: 'false', context: { TELNET_ENABLED: '0' },
    probes: [imp('config.ts:ssh.enabled', async () => (await fresh<Cfg>('config.ts')).config.ssh.enabled)] },
  { key: 'SSH_PORT', exportForm: 'verbatim', def: '2323', valid: '2324', invalid: 'abc', context: { TELNET_PORT: '2323' },
    probes: [imp('config.ts:ssh.port', async () => (await fresh<Cfg>('config.ts')).config.ssh.port)] },
  { key: 'TELNET_ENABLED', exportForm: '1/0', def: '0', valid: '1', invalid: 'false', context: { SSH_ENABLED: '0' },
    probes: [imp('config.ts:ssh.enabled', async () => (await fresh<Cfg>('config.ts')).config.ssh.enabled)] },
  { key: 'TELNET_PORT', exportForm: 'verbatim', def: '2323', valid: '2324', invalid: 'abc', context: { SSH_PORT: '2323' },
    probes: [imp('config.ts:ssh.port', async () => (await fresh<Cfg>('config.ts')).config.ssh.port)] },
  { key: 'TUI_USERNAME', exportForm: 'verbatim', def: '', valid: ' admin ', invalid: '  ', context: { TUI_PASSWORD: 'pw' }, probes: [call('telnet/session.ts:authFromEnv', () => authFromEnv(process.env))] },
  { key: 'TUI_PASSWORD', exportForm: 'verbatim', def: '', valid: ' s3cret ', invalid: '  ', context: { TUI_USERNAME: undefined }, probes: [call('telnet/session.ts:authFromEnv', () => authFromEnv(process.env))] },
  { key: 'TUI_TRUSTED_ORIGINS', exportForm: 'verbatim', def: '', valid: ' https://a.example , https://b.example,, ', invalid: 'nourl',
    probes: [mirror('auth.ts:239 trusted origins', 'auth.ts', "(process.env.TUI_TRUSTED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)", () => (E('TUI_TRUSTED_ORIGINS') ?? '').split(',').map((x) => x.trim()).filter(Boolean))] },
  { key: 'RECORDER_RETENTION_DAYS', exportForm: 'verbatim', def: '30', valid: '365', invalid: 'abc', extra: { belowFloor: '3', outOfRange: '4000', decimal: '12.6' },
    probes: [call('retention.ts:resolveRetentionDays', (raw) => resolveRetentionDays(raw))] },
  { key: 'ECOFLOW_DEVICE_REACHABILITY', exportForm: 'verbatim', def: '', valid: '{"Y711XXX00XXX0001":"binary_sensor.core1_lan","BAD":"Not.Valid"}', invalid: '{not json',
    probes: [call('deviceLink.ts:deviceReachabilityEntities', () => deviceReachabilityEntities())] },
  { key: 'WRITE_DEBUG_TOKEN', exportForm: 'verbatim', def: '', valid: 'tok', invalid: '0', probes: [call('ecoflow/commands.ts:isWriteDebugEnabled', () => isWriteDebugEnabled())] },
];

export const STANDARD_VARIANTS = ['unset', 'blank', 'null', 'default', 'valid', 'invalid'] as const;

export function variantsOf(spec: KeySpec): Record<string, string | undefined> {
  return { unset: undefined, blank: '', null: 'null', default: spec.def, valid: spec.valid, invalid: spec.invalid, ...(spec.extra ?? {}) };
}

/** Every variable any probe may read, cleared before each key so no stray environment leaks in. */
export const ALL_KEYS = KEYS.map((k) => k.key);

export async function G3(): Promise<unknown> {
  const anchors: Record<string, boolean> = {};
  const out: Record<string, unknown> = {};
  const clear: EnvPatch = Object.fromEntries(ALL_KEYS.map((k) => [k, undefined]));
  for (const spec of KEYS) {
    for (const p of spec.probes) {
      const check = p.anchorNow ?? p.movedTo ?? p.cite;
      if (check) {
        const text = readFileSync(resolve(SRC, check.file), 'utf8');
        const present = text.includes(check.anchor);
        anchors[`${p.reader}`] = present;
        if (!present) throw new Error(`G3 anchor moved: ${p.reader} expects ${JSON.stringify(check.anchor)} in ${check.file}`);
      }
    }
    const variants: Record<string, unknown> = {};
    for (const [vName, raw] of Object.entries(variantsOf(spec))) {
      variants[vName] = await withEnv({ ...clear, ...(spec.context ?? {}), [spec.key]: raw }, async () => {
        const readers: Record<string, unknown> = {};
        for (const p of spec.probes) readers[p.reader] = await p.get(raw);
        return { raw, readers };
      });
    }
    out[spec.key] = {
      exportForm: spec.exportForm,
      probes: spec.probes.map((p) => ({ reader: p.reader, how: p.how, derived: p.derived === true, cite: p.cite ?? null })),
      variants,
    };
  }
  return { keyCount: KEYS.length, keys: out };
}
