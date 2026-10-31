import 'dotenv/config';
import { bindTopologyOptions } from './topology.js';
import { resolve } from 'node:path';
import { DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from './siteDefaults.js';

/**
 * Runtime configuration — THE option table.
 *
 * v1.191.0 (S2) — `OPTIONS` registers every add-on option (the 85 `config.yaml` keys with a default, and the
 * schema-only keys the lanes add), every bridged environment knob and the deployment constants, each with
 * the parse rule its current reader applies.
 * The rules are carried per key on purpose: four truthiness conventions coexist in the run script and
 * the code (`!== '0'`, `=== 'true' || === '1'`, `!== 'false'`, `!(=== 'false' || === '0')`), and a
 * single "accepts both" parser would invert a flag (NOTIFY_CRITICAL_BYPASS_DND read `'false'` as on
 * once already). The blank and `'null'` rules are per key for the same reason. The goldens
 * (test/golden/G3.json) pin what each reader sees for each key under eight inputs, and golden.test.ts
 * holds every row here to them; optionsDefaultParity.test.ts compares each row's value when the
 * variable is absent with the shipped default, and anything that differs is listed in
 * DECLARED_DIVERGENCES with its reason.
 *
 * This file is the only reader of `process.env` (test/processEnvRatchet.test.ts counts the others and
 * lets the count fall only). Consumers move onto `config` / `option()` lane by lane; until a consumer
 * has moved, its own read is the one that runs and the row here is its documented twin.
 *
 * v0.9.0 — the secret keys use lazy getters that throw on first ACCESS rather than at module load, so
 * importing this file never fails a process that does not call the EcoFlow API (tests, scripts).
 */

export type OptionSource = 'option' | 'env-only' | 'deploy';
/** `has_value`: a schema-only optional key (no `options:` default), exported verbatim only while it has a
 *  value (`if bashio::config.has_value 'KEY'; then export KEY=…; fi`), so an unset key leaves the variable
 *  absent. v1.191.0 lane A adds the first one (SITE_TIMEZONE). */
export type ExportForm = '1/0' | 'true/false' | 'verbatim' | 'has_value';

/** Read-only access to the other variables, for the few rows whose rule depends on another key. */
export interface Env { get(name: string): string | undefined }

export interface OptionRow<T = unknown> {
  readonly name: string;
  /** `option`: a config.yaml key the run script exports. `env-only`: a knob read from the environment only
   *  (a lane may bridge it later). `deploy`: set by the image or the run script, never by the user. */
  readonly source: OptionSource;
  readonly doc: string;
  /** The run script's export convention for an `option` row; the bridge test holds the script to it. */
  readonly exportForm?: ExportForm;
  /** The numeric range the parse clamps to. For an `option` row with a ranged schema it must equal the
   *  schema range, or the difference is listed in DECLARED_DIVERGENCES (kind 'clamp'). */
  readonly clamp?: { min?: number; max?: number };
  /** The reader whose rule this row reproduces. For a key golden G3 covers (test/golden/support/g3.ts),
   *  the G3 probe id as g3.ts names it: a line number in it is the line on the tree G3 was captured
   *  from, frozen with the golden (test/golden.test.ts matches it against the probes). For any other
   *  key, free text naming the reader, with file:line on the current tree when it cites a line. */
  readonly canonicalReader: string;
  /** Readers of the same key that apply a different rule for some inputs, each with that rule. */
  readonly divergentReaders?: Readonly<Record<string, string>>;
  /** The canonical reader exposes a view derived from the value (e.g. "is it set?"); this maps to it. */
  readerView?(value: T): unknown;
  /** The structured value is produced by this module function from the string this row yields
   *  (the parser stays in its module until its lane moves it). */
  readonly structuredBy?: string;
  /** Parse the exported string (`undefined` when the variable is absent) into the value the reader sees. */
  readonly parse: (raw: string | undefined, env: Env) => T;
}

/* ───────────────────────────── shared parsers ───────────────────────────── */

export type BoolRule = 'not0' | 'trueOr1' | 'notFalse' | 'notFalseNot0' | 'true' | 'oneOrTrueCI';

/** The four truthiness conventions in use, plus the two strict forms. Carried per key; never "accept both". */
export const bool = (rule: BoolRule) => (raw: string | undefined): boolean => {
  switch (rule) {
    case 'not0': return raw !== '0';
    case 'trueOr1': return raw === 'true' || raw === '1';
    case 'notFalse': return raw !== 'false';
    case 'notFalseNot0': return !(raw === 'false' || raw === '0');
    case 'true': return raw === 'true';
    case 'oneOrTrueCI': return raw === '1' || raw?.toLowerCase() === 'true';
  }
};
/** `raw ?? d`. */
export const str = (d: string) => (raw: string | undefined): string => raw ?? d;
/** `raw || d`: a blank reads as the default. */
export const strOr = (d: string) => (raw: string | undefined): string => raw || d;
/** `(raw ?? d).trim()`. */
export const trimmed = (d = '') => (raw: string | undefined): string => (raw ?? d).trim();
/** A trimmed string, or null when absent or blank. */
export const trimmedOrNull = () => (raw: string | undefined): string | null => {
  if (!raw) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
};
/** `Number(raw ?? d)`: a blank reads as 0 and garbage as NaN — the bare rule most numeric options use today. */
export const numOr = (d: number) => (raw: string | undefined): number => Number(raw ?? d);
/** A schema-only number: absent, blank or non-finite is null (unset); the rest is clamped to [lo, hi]. */
export const floatOrNull = (lo: number, hi: number) => (raw: string | undefined): number | null => {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
/** `envClamped`: absent, blank or non-finite takes the default; the rest is clamped to [lo, hi]. */
export const numClamped = (d: number, lo: number, hi: number) => (raw: string | undefined): number => {
  const n = raw == null || raw.trim() === '' ? d : Number(raw);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d));
};
/** `clampIntEnv`: as numClamped, rounded to an integer. */
export const intClamped = (d: number, lo: number, hi: number) => (raw: string | undefined): number => {
  const n = raw == null || raw.trim() === '' ? d : Number(raw);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};
/** `clampInt(Number(raw ?? d), lo, hi, d)`: a blank reads as 0 (then clamped); only a non-finite value takes the default. */
export const intClampedNum = (d: number, lo: number, hi: number) => (raw: string | undefined): number => {
  const v = Number(raw ?? d);
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, Math.round(v)));
};
/** A finite number ≥ 0, else the default (the EV plateau rule). */
export const nonNegativeOr = (d: number) => (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
/** A comma list, trimmed, blanks dropped, optionally filtered. */
export const csv = (keep: (s: string) => boolean = () => true) => (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && keep(s));
/** `HH-HH` → [start, end] with both in 0..23, else null (alertMonitor.ts parseQuietHours). */
export function quietHours(s: string): [number, number] | null {
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) return null;
  return [start, end];
}
/** One of `allowed`, else `d` (case-sensitive, as the readers compare). */
export const enumOr = <T extends string>(allowed: readonly T[], d: T) => (raw: string | undefined): T =>
  (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : d;
/** A tariff cent: absent or blank is null (unconfirmed); any finite number counts (tariff.ts apsREvRatesFromEnv). */
export const cent = () => (raw: string | undefined): number | null => {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
/** analytics.ts apsCent: as `cent`, but only a value above zero counts. */
export const centPositive = () => (raw: string | undefined): number | null => {
  const n = cent()(raw);
  return n != null && n > 0 ? n : null;
};

/* ───────────────────── the LAN console's option aliases ───────────────────── */

/** The LAN console's resolved transport settings (SSH). */
export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Where the ed25519 host key lives; generated on first start. */
  hostKeyPath: string;
}

/** The SSH port the add-on publishes (`ports:` in config.yaml); SSH_PORT's shipped default. */
export const SSH_DEFAULT_PORT = 2323;

/**
 * The LAN console is served over SSH.
 *
 *   enabled  — SSH_ENABLED; off only for '0' (absent reads as on — the run script always
 *              exports 1 or 0); off ⇒ /console only.
 *   port     — SSH_PORT, default 2323.
 *   host     — SSH_HOST, else `::`.
 *   hostKey  — SSH_HOST_KEY, else /data/ssh_host_ed25519_key.
 *
 * v1.191.6 — the deprecated TELNET_ENABLED / TELNET_PORT / TELNET_HOST aliases are gone
 * (telnet has not been served since v1.190.0); an install that still carries them in its
 * saved options gets the Supervisor's "does not exist in the schema" notice and SSH_* rule.
 *
 * The four keys it reads each have an OPTIONS row below whose parse calls this function with
 * that key's value in place (`sshView`), so the table reproduces the resolver by construction.
 */
export function resolveSshConfig(env: NodeJS.ProcessEnv = process.env): SshConfig {
  return {
    enabled: env.SSH_ENABLED !== '0',
    host: env.SSH_HOST ?? '::',
    port: Number(env.SSH_PORT ?? SSH_DEFAULT_PORT),
    hostKeyPath: env.SSH_HOST_KEY ?? '/data/ssh_host_ed25519_key',
  };
}

/** Every variable resolveSshConfig reads. */
const SSH_KEYS = ['SSH_ENABLED', 'SSH_PORT', 'SSH_HOST', 'SSH_HOST_KEY'] as const;
/** The resolver's view of a row's environment, with the row's own value in place of the variable. */
const sshView = (name: string, raw: string | undefined, env: Env): NodeJS.ProcessEnv =>
  Object.fromEntries(SSH_KEYS.map((k) => [k, k === name ? raw : env.get(k)]));
const sshField = <K extends keyof SshConfig>(name: string, field: K) => (raw: string | undefined, env: Env): SshConfig[K] =>
  resolveSshConfig(sshView(name, raw, env))[field];

/* ───────────────────────────── the table ───────────────────────────── */

// v1.191.0 (lane C) — the placeholder coordinates live in a side-effect-free leaf (siteDefaults.ts) so the
// physics and the energy bridge can name them without importing this module; re-exported here.
export { DEFAULT_SITE_LAT, DEFAULT_SITE_LON };
/**
 * v1.191.0 (lane A, plan 2.4) — the site clock's last fallback: the zone the code assumed before the site
 * zone became configurable. The ONLY copy of this literal in server/src (siteTimeLiteral.test.ts holds
 * that); siteTime.ts resolves SITE_TIMEZONE → TZ → this.
 */
export const DEFAULT_SITE_TIME_ZONE = 'America/Phoenix';
/** v1.191.0 (S5, F1) — the flat ¢/kWh the cost figures and the MPC fall back to while no confirmed rate
 *  prices an hour (TARIFF_FLAT_CENTS_PER_KWH's value when absent). One constant: three copies until
 *  v1.191.0 (analytics.ts, index.ts, dispatch/mpc.ts); tariff.ts re-exports it. */
export const TARIFF_FLAT_DEFAULT_CENTS = 17;
/** A schema-only string option: trimmed, and null when absent or blank (the run script exports it only when set). */
const specOrNull = (raw: string | undefined): string | null => {
  if (raw == null) return null;
  const t = raw.trim();
  return t === '' ? null : t;
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
const announceVolume = (raw: string | undefined, fallbackVol01: number): number | null => {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'standing') return null;
  if (v !== '' && Number.isFinite(Number(v))) return Math.max(0, Math.min(100, Math.round(Number(v))));
  return Math.round(fallbackVol01 * 100);
};
const tuiAuth = (username: string | undefined, password: string | undefined): { username: string; password: string } | null => {
  const pw = (password ?? '').trim();
  if (pw.length === 0) return null;
  return { username: (username ?? '').trim() || 'operator', password: pw };
};
const HA_SCHEMA_VALIDATES = 'the schema range is validated by Home Assistant; the code does not clamp a hand-set environment value';

function row<T>(r: OptionRow<T>): OptionRow<T> { return r; }

const ROWS: readonly OptionRow[] = [
  // ── Credentials & core ─────────────────────────────────────────────────
  row({ name: 'ECOFLOW_ACCESS_KEY', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:lazyRequired',
    doc: 'EcoFlow IoT-Open API access key; required (the run script exits without it, the getter throws on first use).',
    parse: (raw) => { if (!raw) throw new Error('Missing required env var: ECOFLOW_ACCESS_KEY'); return raw; } }),
  row({ name: 'ECOFLOW_SECRET_KEY', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:lazyRequired',
    doc: 'EcoFlow IoT-Open API secret; required.',
    parse: (raw) => { if (!raw) throw new Error('Missing required env var: ECOFLOW_SECRET_KEY'); return raw; } }),
  row({ name: 'ECOFLOW_API_HOST', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:apiHost', doc: 'EcoFlow cloud API base URL.', parse: str('https://api-a.ecoflow.com') }),
  row({ name: 'LOG_LEVEL', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:logLevel', doc: 'Pino log level.', parse: str('info') }),
  row({ name: 'FORECAST_LAT', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:forecastLat',
    doc: 'Site latitude for the solar forecast and the day/night test; the default is a placeholder.', parse: numOr(DEFAULT_SITE_LAT) }),
  row({ name: 'FORECAST_LON', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:forecastLon',
    doc: 'Site longitude for the solar forecast and the day/night test; the default is a placeholder.', parse: numOr(DEFAULT_SITE_LON) }),
  // ── Push notifications ─────────────────────────────────────────────────
  row({ name: 'NOTIFY_CHANNEL', source: 'option', exportForm: 'verbatim', canonicalReader: 'notify.ts:loadNotifyConfig',
    doc: "Home Assistant notifications on ('ha') or off; anything else fails safe to 'none'.",
    parse: (raw) => ((raw ?? 'none').toLowerCase() === 'ha' ? 'ha' : 'none') }),
  row({ name: 'NOTIFY_MIN_SEVERITY', source: 'option', exportForm: 'verbatim', canonicalReader: 'notify.ts:loadNotifyConfig',
    doc: "Minimum severity that pushes; anything but 'critical' reads as 'warning'.",
    parse: (raw) => ((raw ?? 'warning').toLowerCase() === 'critical' ? 'critical' : 'warning') }),
  row({ name: 'NOTIFY_RESOLVED', source: 'option', exportForm: '1/0', canonicalReader: 'notify.ts:loadNotifyConfig', doc: 'Also push when an alert clears.', parse: bool('not0') }),
  row({ name: 'NOTIFY_HA_PUSH_TARGETS', source: 'option', exportForm: 'verbatim', canonicalReader: 'notify.ts:loadNotifyConfig',
    doc: 'HA notify services that receive the push (comma list; a notify. prefix is dropped; only [a-z0-9_] names kept).',
    parse: (raw) => (raw ?? '').split(',').map((t) => t.trim().replace(/^notify\./i, '')).filter((t) => /^[a-z0-9_]+$/i.test(t)) }),
  row({ name: 'NOTIFY_CRITICAL_BYPASS_DND', source: 'option', exportForm: '1/0', canonicalReader: 'notify.ts:loadNotifyConfig',
    doc: "Critical pushes carry the companion app's critical payload. The run script exports 1/0 because this reads `!== '0'`.", parse: bool('not0') }),
  row({ name: 'NOTIFY_QUIET_HOURS', source: 'option', exportForm: 'verbatim', canonicalReader: 'alertMonitor.ts:2650 QUIET_WINDOW',
    doc: 'Push quiet window HH-HH; a blank or malformed value means no window.',
    divergentReaders: { 'index.ts:2699 quietConfigured': "`(raw ?? '').trim() !== ''` — whether any quiet hours were configured, for the off-grid warning" },
    parse: (raw) => quietHours(raw ?? '22-06') }),
  row({ name: 'NOTIFY_DIGEST_HOUR', source: 'option', exportForm: 'verbatim', canonicalReader: 'alertMonitor.ts:2656 DIGEST_HOUR',
    doc: 'Hour of the morning digest. Bare Number(): a blank reads as 0.', parse: numOr(7) }),
  // ── Audible broadcast ──────────────────────────────────────────────────
  row({ name: 'BROADCAST_ENABLED', source: 'option', exportForm: 'true/false', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Master enable for audible broadcast (the /data runtime override wins when set).', parse: bool('trueOr1') }),
  row({ name: 'BROADCAST_TARGETS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Music-Assistant media_player targets (comma list; only media_player.* entries kept).', parse: csv((s) => s.startsWith('media_player.')) }),
  row({ name: 'BROADCAST_SIP_TARGETS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Announce-only media_player targets; an entry also in BROADCAST_TARGETS is dropped here.',
    parse: (raw, env) => { const targets = csv((s) => s.startsWith('media_player.'))(env.get('BROADCAST_TARGETS')); return csv((s) => s.startsWith('media_player.') && !targets.includes(s))(raw); } }),
  row({ name: 'BROADCAST_MIN_SEVERITY', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: "Minimum severity for an audible broadcast; anything but 'warning' reads as 'critical'.",
    parse: (raw) => ((raw ?? 'critical') === 'warning' ? 'warning' : 'critical') }),
  row({ name: 'BROADCAST_QUIET_HOURS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Audible quiet window HH-HH. Absent reads as no window (the add-on always exports it).',
    divergentReaders: { 'index.ts:2699 quietConfigured': "`(raw ?? '').trim() !== ''` — whether any quiet hours were configured" },
    parse: (raw) => quietHours(raw ?? '') }),
  row({ name: 'CRITICAL_BREAKS_QUIET_HOURS', source: 'option', exportForm: 'true/false', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Critical alerts break through quiet hours (push and audible).', parse: bool('trueOr1') }),
  row({ name: 'BROADCAST_AUDIO_BASE', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: 'Base URL the speakers fetch audio from; a blank reads as the default; a trailing slash is dropped.',
    parse: (raw) => (raw || 'http://homeassistant.local:8787').replace(/\/$/, '') }),
  row({ name: 'BROADCAST_VOLUME', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 0, max: 1 },
    doc: 'Chime volume 0..1; non-finite reads as 0.5.', parse: (raw) => clamp01(Number(raw ?? 0.5)) }),
  row({ name: 'BROADCAST_ANNOUNCE_VOLUME', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: "Announce volume 0..100; 'off'/'none'/'standing' omit it (null); blank follows BROADCAST_VOLUME × 100.",
    parse: (raw, env) => announceVolume(raw, clamp01(Number(env.get('BROADCAST_VOLUME') ?? 0.5))) }),
  row({ name: 'BROADCAST_USE_PRE_ANNOUNCE', source: 'option', exportForm: 'true/false', canonicalReader: 'broadcast.ts:loadBroadcastConfig', doc: "Play the platform's pre-announce tone.", parse: bool('trueOr1') }),
  row({ name: 'BROADCAST_LEAD_SILENCE_MS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 0, max: 5000 },
    doc: 'Lead-in silence in ms; absent, blank or malformed reads as 1500 (OWNER DECISION 7 keeps 1500 against the 1000 shipped).', parse: intClamped(1500, 0, 5000) }),
  row({ name: 'BROADCAST_REPEAT', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 1, max: 3 }, doc: 'Announcement repeats.', parse: intClamped(2, 1, 3) }),
  row({ name: 'BROADCAST_REPEAT_GAP_MS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 0, max: 5000 }, doc: 'Gap between repeats.', parse: intClamped(1500, 0, 5000) }),
  row({ name: 'BROADCAST_CHIME_GAP_MS', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 0, max: 5000 }, doc: 'Gap between the chime and the speech.', parse: intClamped(1000, 0, 5000) }),
  row({ name: 'BROADCAST_ANNOUNCE_RETRIES', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', clamp: { min: 0, max: 3 }, doc: 'Retries of a failed announce call.', parse: intClamped(1, 0, 3) }),
  row({ name: 'BROADCAST_WYOMING_HOST', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', doc: 'Wyoming/Piper host; a blank reads as the default.', parse: strOr('core-piper') }),
  row({ name: 'BROADCAST_WYOMING_PORT', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', doc: 'Wyoming port; 0, blank or malformed reads as 10200.', parse: (raw) => Number(raw) || 10200 }),
  row({ name: 'BROADCAST_WYOMING_VOICE', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', doc: 'Piper voice (English); blank means the server default (null).', parse: trimmedOrNull() }),
  row({ name: 'BROADCAST_BILINGUAL', source: 'option', exportForm: 'true/false', canonicalReader: 'broadcast.ts:loadBroadcastConfig',
    doc: "Second pass in Spanish; off only for 'false' or '0'.", parse: bool('notFalseNot0') }),
  row({ name: 'BROADCAST_WYOMING_VOICE_ES', source: 'option', exportForm: 'verbatim', canonicalReader: 'broadcast.ts:loadBroadcastConfig', doc: 'Piper voice for the Spanish pass (trimmed; blank = inactive).', parse: trimmed('') }),
  // ── Battery & grid alarms ──────────────────────────────────────────────
  row({ name: 'BATTERY_SOC_ALARM_ENABLED', source: 'option', exportForm: 'true/false', canonicalReader: 'index.ts:2500 socAlarmEnabled', doc: 'State-of-charge ladder alarm.', parse: bool('notFalse') }),
  row({ name: 'BATTERY_RUNWAY_ALARM_ENABLED', source: 'option', exportForm: 'true/false', canonicalReader: 'index.ts:2524 runwayAlarmEnabled', doc: 'Runway (time-to-reserve) alarm.', parse: bool('notFalse') }),
  row({ name: 'BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN', source: 'option', exportForm: 'verbatim', canonicalReader: 'runwayAlarm.ts:RUNWAY_ALARM_REANNOUNCE_MS', clamp: { min: 1 },
    doc: 'Re-announce cadence, read as milliseconds: max(1, Number(raw ?? 60)) minutes.', parse: (raw) => Math.max(1, Number(raw ?? 60)) * 60 * 1000 }),
  row({ name: 'GRID_AVAILABLE', source: 'option', exportForm: 'true/false', canonicalReader: 'gridState.ts:633 gridAvailableFallback',
    doc: "Grid-tied site; only the string 'true' counts.", parse: bool('true') }),
  row({ name: 'GRID_PRESENCE_ENTITY', source: 'option', exportForm: 'verbatim', canonicalReader: 'gridState.ts:gridPresenceEntityId', doc: 'HA entity reporting grid presence (trimmed).', parse: trimmed('') }),
  row({ name: 'GRID_FLOOR_SLACK_PCT', source: 'option', exportForm: 'verbatim', canonicalReader: 'gridState.ts:floorSlackPct', clamp: { min: 0, max: 10 },
    doc: "Points above the reserve where a flow-less grid stops being trusted; absent, blank, 'null' or garbage read as 1.5.",
    parse: (raw) => { if (raw == null || raw.trim() === '' || raw === 'null') return 1.5; const n = Number(raw); return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 1.5; } }),
  row({ name: 'CHARGE_NOW_RESPONSE', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:4922 CHARGE_NOW_MODE',
    doc: "Response to on-peak Charge Now: off | advisory | supervised; anything else fails to 'advisory'.", parse: enumOr(['supervised', 'off', 'advisory'] as const, 'advisory') }),
  row({ name: 'HOST_POWER_ENTITY', source: 'option', exportForm: 'verbatim', canonicalReader: 'hostPower.ts:hostPowerEntityId', doc: "HA binary_sensor for the host's under-voltage flag (trimmed).", parse: trimmed('') }),
  // ── Load-shedding advisor ──────────────────────────────────────────────
  row({ name: 'LOAD_SHEDDING_ADVISORY_ENABLED', source: 'option', exportForm: 'true/false', canonicalReader: 'index.ts:2715 loadShedAdvisoryEnabled', doc: 'Load-shedding advisor.', parse: bool('notFalse') }),
  row({ name: 'LOAD_SHEDDING_SHED_ENTITIES', source: 'option', exportForm: 'verbatim', canonicalReader: 'loadShedRegistry.ts:parseShedCandidates', structuredBy: 'loadShedRegistry.ts:parseShedCandidates',
    doc: 'Shed candidates, entity:priority:label:watts:channel per entry (parsed by loadShedRegistry.ts; absent and blank alike give none).', parse: (raw) => raw ?? '' }),
  row({ name: 'LOAD_SHEDDING_RUNWAY_THRESHOLD_H', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:2727 thresholdHours', doc: 'Runway hours below which shedding is advised. Bare Number().', parse: numOr(4.0) }),
  row({ name: 'LOAD_SHEDDING_RESTORE_MARGIN_H', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:2728 restoreMarginHours', doc: 'Margin above the threshold before restoring is advised. Bare Number().', parse: numOr(2.0) }),
  // ── Night-charge engine ────────────────────────────────────────────────
  row({ name: 'NIGHT_CHARGE_ADVISOR_ENABLED', source: 'option', exportForm: 'true/false', canonicalReader: 'index.ts:3126 nightChargeEnabled', doc: 'Night-charge planner.', parse: bool('notFalse') }),
  row({ name: 'NIGHT_CHARGE_MODE', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3142 NIGHT_CHARGE_MODE',
    doc: "advisory | supervised | auto; anything else fails closed to 'advisory'.", parse: enumOr(['supervised', 'auto', 'advisory'] as const, 'advisory') }),
  row({ name: 'ARB_OUTAGE_CUSHION_PCT', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3422 cushionPct', doc: 'Legacy cushion, percent of pool. Bare Number().', parse: numOr(15) }),
  row({ name: 'ARB_OUTAGE_CUSHION_HOURS', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3426 outageCushionHours', doc: 'Hours of outage the cushion must carry. Bare Number().', parse: numOr(4) }),
  row({ name: 'ARB_ISLANDED_LOAD_SAFETY', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3432 islandedLoadSafety', doc: 'Multiplier on the measured islanded load. Bare Number().', parse: numOr(1.25) }),
  row({ name: 'ARB_OBJECTIVE', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3146 FORCE_CHARGE_OBJECTIVE',
    doc: "'cost' (case-insensitive) or 'resilience'.", parse: (raw) => ((raw ?? 'resilience').toLowerCase() === 'cost' ? 'cost' : 'resilience') }),
  row({ name: 'ARB_COST_MAX_SOC_PCT', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3147 FORCE_CHARGE_COST_MAX_SOC_PCT', doc: 'Cost-mode fill ceiling. Bare Number().', parse: numOr(90) }),
  row({ name: 'ARB_MIN_BUY_KWH', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3505 minBuyKwh', doc: 'Below this buy the night is a hold (also the clean-baseline bound in scoring). Bare Number().', parse: numOr(1) }),
  row({ name: 'ARB_CHARGE_CAP_KW', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3437 chargeCapKw', doc: 'Grid-side charge cap; 0 = automatic (planChargeCapKw). Bare Number().', parse: numOr(0) }),
  row({ name: 'ARB_GRID_INPUT_CAP_KW', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:5334 gridInputCapKwFromEnv',
    doc: 'Shared grid-input envelope in kW; 0, negative or unparseable reads as null (contention not modelled).',
    parse: (raw) => { const n = Number(raw ?? 17); return Number.isFinite(n) && n > 0 ? n : null; } }),
  row({ name: 'ARB_LOAD_P90_FACTOR', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3451 loadBandFloor', doc: 'Floor of the load-band multiplier. Bare Number().', parse: numOr(1.15) }),
  row({ name: 'NIGHT_CHARGE_NOTIFY_HOUR', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3131 NIGHT_CHARGE_NOTIFY_HOUR', clamp: { min: 0, max: 22 },
    doc: 'Hour of the evening job, clamped to 0..22 (the APS catch-up window ends at 23:00; another plan clamps further, to the hour before its cheap window opens: nightSchedule.ts notifyHourMax); non-finite reads as 21.', parse: intClampedNum(21, 0, 22) }),
  row({ name: 'NIGHT_CHARGE_NOTIFY_MINUTE', source: 'option', exportForm: 'verbatim', canonicalReader: 'index.ts:3132 NIGHT_CHARGE_NOTIFY_MINUTE', clamp: { min: 0, max: 59 },
    doc: 'Minute of the evening job; non-finite reads as 30.', parse: intClampedNum(30, 0, 59) }),
  row({ name: 'NIGHT_CHARGE_NOTIFY_ON_HOLD', source: 'option', exportForm: 'true/false', canonicalReader: 'index.ts:4544 notifyOnHold', doc: 'Send the nightly notice on hold nights too.', parse: bool('notFalse') }),
  row({ name: 'HEARTBEAT_URL', source: 'option', exportForm: 'verbatim', canonicalReader: 'heartbeat.ts:183 urlConfigured',
    doc: 'Outside dead-man receiver (https URL, trimmed); blank = off. Validation stays in heartbeat.ts.',
    readerView: (v) => (v as string) !== '', parse: trimmed('') }),
  row({ name: 'HEARTBEAT_INTERVAL_S', source: 'option', exportForm: 'verbatim', canonicalReader: 'heartbeat.ts:heartbeatIntervalMs', clamp: { min: 60, max: 3600 },
    doc: 'Seconds between pings, clamped to 60..3600 and read as milliseconds; absent, blank or malformed reads as 300 s.',
    parse: (raw) => { if (raw === undefined || raw.trim() === '') return 300_000; const v = Number(raw); if (!Number.isFinite(v)) return 300_000; return Math.min(3600, Math.max(60, v)) * 1000; } }),
  // ── APS R-EV preset rates ──────────────────────────────────────────────
  ...(['TARIFF_APS_ONPEAK_SUMMER_CENTS', 'TARIFF_APS_ONPEAK_WINTER_CENTS', 'TARIFF_APS_OFFPEAK_SUMMER_CENTS', 'TARIFF_APS_OFFPEAK_WINTER_CENTS', 'TARIFF_APS_OVERNIGHT_CENTS', 'TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS'] as const)
    .map((name) => row({ name, source: 'option', exportForm: 'verbatim', canonicalReader: 'tariff.ts:apsREvRatesFromEnv',
      doc: 'APS R-EV effective ¢/kWh for the period and season; blank = unconfirmed (null); any finite value counts.',
      divergentReaders: { 'analytics.ts:apsCent': 'the KPI path accepts a value above zero only (OWNER DECISION 8 keeps both rules)' },
      parse: cent() })),
  row({ name: 'TARIFF_APS_RATES_CONFIRMED', source: 'option', exportForm: 'true/false', canonicalReader: 'tariff.ts:apsREvRatesFromEnv',
    doc: "The rates come from a bill; only the string 'true' counts.", parse: bool('true') }),
  // ── Integrations ───────────────────────────────────────────────────────
  row({ name: 'NWS_ENABLED', source: 'option', exportForm: '1/0', canonicalReader: 'nws.ts:isNwsEnabled', doc: "NWS storm alerts; '1' or 'true' (any case).", parse: bool('oneOrTrueCI') }),
  row({ name: 'MQTT_DISCOVERY_ENABLED', source: 'option', exportForm: '1/0', canonicalReader: 'mqttDiscovery.ts:isMqttDiscoveryEnabled',
    doc: "MQTT discovery: '1' or 'true' (any case) AND a non-empty MQTT_DISCOVERY_HOST.",
    parse: (raw, env) => bool('oneOrTrueCI')(raw) && !!env.get('MQTT_DISCOVERY_HOST') }),
  row({ name: 'MQTT_DISCOVERY_HOST', source: 'option', exportForm: 'verbatim', canonicalReader: 'mqttDiscovery.ts:1145 host',
    doc: 'MQTT broker host, verbatim; a blank disables discovery.',
    divergentReaders: { 'mqttDiscovery.ts:isMqttDiscoveryEnabled': 'the enable gate reads it as `!!host`' }, parse: (raw) => raw }),
  row({ name: 'MQTT_DISCOVERY_PORT', source: 'option', exportForm: 'verbatim', canonicalReader: 'mqttDiscovery.ts:1146 port', doc: 'MQTT broker port. Bare Number().', parse: numOr(1883) }),
  row({ name: 'MQTT_DISCOVERY_USER', source: 'option', exportForm: 'verbatim', canonicalReader: 'mqttDiscovery.ts:1147 user', doc: 'MQTT username, verbatim (a blank is passed through).', parse: (raw) => raw }),
  row({ name: 'MQTT_DISCOVERY_PASS', source: 'option', exportForm: 'verbatim', canonicalReader: 'mqttDiscovery.ts:1148 pass', doc: 'MQTT password, verbatim.', parse: (raw) => raw }),
  row({ name: 'MQTT_DISCOVERY_PREFIX', source: 'option', exportForm: 'verbatim', canonicalReader: 'mqttDiscovery.ts:1149 prefix', doc: 'Discovery topic prefix; a blank passes through as an empty prefix.', parse: str('homeassistant') }),
  // ── SSH console (v1.190.0; the TELNET_* aliases were removed in v1.191.6) ──
  row({ name: 'SSH_ENABLED', source: 'option', exportForm: '1/0', canonicalReader: 'config.ts:ssh.enabled',
    doc: "SSH console listener; off only for '0' (absent reads as on — the run script always exports 1 or 0).",
    parse: sshField('SSH_ENABLED', 'enabled') }),
  row({ name: 'SSH_PORT', source: 'option', exportForm: 'verbatim', canonicalReader: 'config.ts:ssh.port',
    doc: 'SSH console port. Bare Number().', parse: sshField('SSH_PORT', 'port') }),
  row({ name: 'TUI_USERNAME', source: 'option', exportForm: 'verbatim', canonicalReader: 'console/session.ts:authFromEnv',
    doc: "Console login username (trimmed; blank reads as 'operator'); the gate is off while TUI_PASSWORD is blank.",
    parse: (raw, env) => tuiAuth(raw, env.get('TUI_PASSWORD')) }),
  row({ name: 'TUI_PASSWORD', source: 'option', exportForm: 'verbatim', canonicalReader: 'console/session.ts:authFromEnv',
    doc: 'Console login password (trimmed); blank disables the login gate.', parse: (raw, env) => tuiAuth(env.get('TUI_USERNAME'), raw) }),
  row({ name: 'TUI_TRUSTED_ORIGINS', source: 'option', exportForm: 'verbatim', canonicalReader: 'auth.ts:239 trusted origins', doc: 'Exact browser origins added to the same-origin set (comma list).', parse: csv() }),
  // ── Diagnostic / advanced ──────────────────────────────────────────────
  row({ name: 'RECORDER_RETENTION_DAYS', source: 'option', exportForm: 'verbatim', canonicalReader: 'retention.ts:resolveRetentionDays', clamp: { min: 7, max: 3650 },
    doc: 'Raw-sample retention in days, rounded and clamped to 7..3650; absent, blank or malformed reads as 30.',
    parse: (raw) => { const n = Number(raw); if (raw == null || raw === '' || !Number.isFinite(n)) return 30; return Math.min(3650, Math.max(7, Math.round(n))); } }),
  row({ name: 'ECOFLOW_DEVICE_REACHABILITY', source: 'option', exportForm: 'verbatim', canonicalReader: 'deviceLink.ts:deviceReachabilityEntities', structuredBy: 'deviceLink.ts:deviceReachabilityEntities',
    doc: 'SN → HA ping entity JSON map (trimmed; parsed and validated by deviceLink.ts).', parse: trimmed('') }),
  row({ name: 'WRITE_DEBUG_TOKEN', source: 'option', exportForm: 'verbatim', canonicalReader: 'ecoflow/commands.ts:isWriteDebugEnabled',
    doc: 'Any non-empty value unlocks POST /api/device/send-command.', readerView: (v) => !!(v && (v as string).length > 0), parse: (raw) => raw }),

  // ── Site (lane A, v1.191.0): schema-only, exported under has_value ─────
  row({ name: 'SITE_TIMEZONE', source: 'option', exportForm: 'has_value', canonicalReader: 'siteTime.ts:resolveSiteTimeZone',
    doc: "The site's IANA time zone (e.g. Europe/Berlin), trimmed; unset or blank falls through to TZ, then America/Phoenix. siteTime.ts validates it with Intl once at boot: a value the runtime cannot resolve raises a repair issue and falls through.",
    parse: trimmedOrNull() }),

  // ── State-file overrides lane A's files read (S3c paths; tests and development only) ──
  row({ name: 'VENDOR_ENERGY_STATE_PATH', source: 'env-only', canonicalReader: 'energyHistory.ts:VENDOR_STATE_PATH',
    doc: 'Overrides the vendor energy ledger file (vendor-energy-daily.json beside the database); absent uses that default.', parse: (raw) => raw }),
  row({ name: 'CURTAIL_MEMBERSHIP_HISTORY_PATH', source: 'env-only', canonicalReader: 'curtailmentFreeze.ts:curtailmentMembershipHistory',
    doc: "Overrides the membership record the curtailment freeze reads; absent reads membership-history.json beside the database inside the add-on, and nothing elsewhere ('' disables).", parse: (raw) => raw }),
  row({ name: 'CURTAILMENT_DAYS_PATH', source: 'env-only', canonicalReader: 'curtailmentFreeze.ts:ensureLoaded',
    doc: "Overrides the frozen curtailment-day store; absent persists curtailment-days.json beside the database inside the add-on, and nothing elsewhere ('' disables).", parse: (raw) => raw }),

  // ── Tariff plan (v1.191.0, lane B; schema-only keys exported under has_value — unset is today's path) ──
  row({ name: 'TARIFF_PLAN', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:resolveTariffFromEnv',
    doc: 'The tariff preset: aps_r_ev (unset: the built-in APS R-EV table), flat, two_tier or custom; an unknown value fails closed (tariff.ts).', parse: specOrNull }),
  row({ name: 'TARIFF_PERIODS', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:parsePeriods',
    doc: 'The custom plan\'s periods in the period grammar (tariff.ts); trimmed, null when unset.', parse: specOrNull }),
  row({ name: 'TARIFF_RATES', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:parseRates',
    doc: 'The custom plan\'s ¢/kWh per period and season (tariff.ts); trimmed, null when unset.', parse: specOrNull }),
  row({ name: 'TARIFF_RATES_CONFIRMED', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:tariffRatesConfirmation',
    doc: "The rates of the plan in effect come from a bill; only 'true' counts; null when unset (TARIFF_APS_RATES_CONFIRMED then decides).",
    parse: (raw) => (raw === undefined ? null : raw === 'true') }),
  row({ name: 'TARIFF_FIXED_DAILY_CENTS', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:buildPlanModel',
    doc: 'Fixed daily basic-service charge in ¢ (informational; surfaced only once confirmed); null when unset, NaN when not a number (fails closed).',
    parse: (raw) => (raw == null || raw.trim() === '' ? null : Number(raw)) }),
  row({ name: 'TARIFF_SUMMER_MONTHS', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:parseMonths',
    doc: 'Usage months that are summer, e.g. 4-9 or a wrapping 10-3; null when unset (the preset\'s 4-9).', parse: specOrNull }),
  row({ name: 'TARIFF_HOLIDAYS', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:parseHolidays',
    doc: 'aps, none or a comma list of YYYY-MM-DD dates; null when unset (aps for aps_r_ev, none otherwise).', parse: specOrNull }),
  row({ name: 'TARIFF_CURRENCY', source: 'option', exportForm: 'has_value', canonicalReader: 'money.ts:tariffCurrency',
    doc: 'ISO 4217 code of the money figures (one of money.ts CURRENCIES); null when unset (USD).', parse: specOrNull }),
  row({ name: 'NIGHT_CHARGE_CHEAP_PERIOD', source: 'option', exportForm: 'has_value', canonicalReader: 'tariff.ts:buildPlanModel',
    doc: 'Overrides the period the night charge plans in (the model\'s cheapPeriodId); must name a period of the plan; null when unset.', parse: specOrNull }),
  // ── Tariff settings bridged under their existing environment names (exported only when set; rules unchanged) ──
  row({ name: 'TARIFF_FLAT_CENTS_PER_KWH', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:TARIFF_FLAT_CENTS', doc: 'Flat ¢/kWh when the rates are unconfirmed (one constant, TARIFF_FLAT_DEFAULT_CENTS); the flat plan\'s rate. Bare Number().', parse: numOr(TARIFF_FLAT_DEFAULT_CENTS) }),
  row({ name: 'TARIFF_ON_PEAK_CENTS', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:apsCent', doc: 'Two-tier on-peak ¢/kWh (KPI path); a value above zero only. The two_tier plan reads it raw.', parse: centPositive() }),
  row({ name: 'TARIFF_OFF_PEAK_CENTS', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:apsCent', doc: 'Two-tier off-peak ¢/kWh (KPI path); a value above zero only. The two_tier plan reads it raw.', parse: centPositive() }),
  row({ name: 'TARIFF_ON_PEAK_CENTS_PER_KWH', source: 'env-only', canonicalReader: 'index.ts:2185 onPeak', doc: 'Two-tier on-peak ¢/kWh (MPC path); absent follows TARIFF_FLAT_CENTS_PER_KWH. Bare Number(). The two_tier plan accepts it as an alias of TARIFF_ON_PEAK_CENTS.', parse: (raw, env) => Number(raw ?? Number(env.get('TARIFF_FLAT_CENTS_PER_KWH') ?? TARIFF_FLAT_DEFAULT_CENTS)) }),
  row({ name: 'TARIFF_OFF_PEAK_CENTS_PER_KWH', source: 'env-only', canonicalReader: 'index.ts:2185 offPeak', doc: 'Two-tier off-peak ¢/kWh (MPC path); absent follows TARIFF_FLAT_CENTS_PER_KWH. Bare Number(). The two_tier plan accepts it as an alias of TARIFF_OFF_PEAK_CENTS.', parse: (raw, env) => Number(raw ?? Number(env.get('TARIFF_FLAT_CENTS_PER_KWH') ?? TARIFF_FLAT_DEFAULT_CENTS)) }),
  row({ name: 'TARIFF_EXPORT_CENTS_PER_KWH', source: 'option', exportForm: 'has_value', canonicalReader: 'dispatch/mpc.ts:EXPORT_TARIFF_CENTS', doc: 'Export ¢/kWh for the MPC. Bare Number().', parse: numOr(0) }),
  row({ name: 'TARIFF_ON_PEAK_HOURS', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:TARIFF_ON_PEAK_HOURS_ENV', doc: 'Legacy on-peak hours "start-end" for the two-tier fallback; the two_tier plan\'s on-peak window.', parse: str('15-20') }),
  row({ name: 'TARIFF_ON_PEAK_DAYS', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:TARIFF_ON_PEAK_DAYS_ENV', doc: 'Legacy on-peak days "first-last" (1=Mon..7=Sun) for the two-tier fallback; the two_tier plan\'s on-peak days.', parse: str('1-5') }),

  // ── PV array and site location (v1.191.0 lane C; schema-only: absent unless set, so unset = today) ──
  row({ name: 'PV_ARRAY_KWP', source: 'option', exportForm: 'has_value', canonicalReader: 'site.ts:pvSite', clamp: { min: 0.1, max: 500 },
    doc: 'PV array nameplate in kWp; unset keeps the reference array (16.8 kWp). Setting any PV_* key moves the PV site onto FORECAST_LAT/LON.',
    parse: floatOrNull(0.1, 500) }),
  row({ name: 'PV_TILT_DEG', source: 'option', exportForm: 'has_value', canonicalReader: 'site.ts:pvSite', clamp: { min: 0, max: 90 },
    doc: 'PV array tilt from horizontal in degrees; unset keeps the reference tilt (25).', parse: floatOrNull(0, 90) }),
  row({ name: 'PV_AZIMUTH_DEG', source: 'option', exportForm: 'has_value', canonicalReader: 'site.ts:pvSite', clamp: { min: 0, max: 360 },
    doc: 'PV array azimuth in degrees clockwise from north (180 = due south); unset keeps 180.', parse: floatOrNull(0, 360) }),
  row({ name: 'PV_STRINGS', source: 'option', exportForm: 'has_value', canonicalReader: 'site.ts:pvStrings', structuredBy: 'site.ts:pvStrings',
    doc: 'PV strings per Core, e.g. hv=10x400,lv=4x400, with per-Core overrides keyed by slot or name (; slot2=hv=8x450); unset keeps 10 + 4 × 400 W.',
    parse: trimmedOrNull() }),
  row({ name: 'SITE_LOCATION_FROM_HA', source: 'option', exportForm: 'has_value', canonicalReader: 'site.ts:siteLocation',
    doc: "Use Home Assistant's home latitude and longitude instead of FORECAST_LAT/LON (read in the background, applied from the next start).",
    parse: bool('true') }),
  row({ name: 'SITE_LOCATION_PATH', source: 'env-only', canonicalReader: 'site.ts:haLocationPath',
    doc: "Where the saved Home Assistant home location lives (SITE_LOCATION_FROM_HA); absent: site-location.json beside the database.",
    parse: (raw) => raw || null }),

  // ── Lane E (v1.191.0, S9): plant limits bridged as schema-only options, exported only when set ──
  // EV (`# --- lane ev ---` in config.yaml). Each schema range equals the clamp here (CA10).
  row({ name: 'EV_MAX_LOAD_W', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:EV_MAX_LOAD_W', clamp: { min: 0 },
    doc: 'Ceiling on predicted EV load per hour, per charger (W); clamped at ≥ 0 only (a NaN propagates). Schema int(0,)?. One reader since v1.191.0 (index.ts parsed it a second time, unclamped).',
    parse: (raw) => Math.max(0, Number(raw ?? 11520)) }),
  row({ name: 'EV_CHARGER_COUNT', source: 'option', exportForm: 'has_value', canonicalReader: 'limits.ts:evChargerCount', clamp: { min: 0, max: 4 },
    doc: 'EV chargers at the site: 0 none (no circuit is classed as EV), 1 overlapping predicted sessions are alternatives (MAX, today), 2..4 they add up (SUM, capped at count × EV_MAX_LOAD_W). Rounded and clamped; absent or malformed reads as 1.',
    parse: intClamped(1, 0, 4) }),
  row({ name: 'EV_PLATEAU_MIN_W', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:EV_PLATEAU_MIN_W', clamp: { min: 0 },
    doc: 'Watts above which a sustained circuit load is EV; any finite value ≥ 0, else 6000. Schema int(0,)?.', parse: nonNegativeOr(6000) }),
  row({ name: 'EV_CIRCUITS', source: 'option', exportForm: 'has_value', canonicalReader: 'limits.ts:parseEvCircuits', structuredBy: 'limits.ts:parseEvCircuits',
    doc: 'SHP2 channels (1..12, comma list) the EV detectors scan; a paired circuit is scanned when either leg is listed. Absent, or no valid channel: every circuit.',
    parse: (raw) => raw }),
  // Limits (`# --- lane limits ---`).
  row({ name: 'FORCE_CHARGE_KW_PER_CORE', source: 'option', exportForm: 'has_value', canonicalReader: 'limits.ts:forceChargeKwPerCore', clamp: { min: 0 },
    doc: 'kW each connected Core takes into its pack while force-charging; absent, blank, 0 or not a positive number reads as null (the measured 5.5 kW). ARB_CHARGE_CAP_KW > 0 still sets the planner cap.',
    parse: (raw) => { if (raw == null || raw.trim() === '') return null; const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : null; } }),
  row({ name: 'RUNWAY_POOL_OVERHEAD_FLOOR_W', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:RUNWAY_POOL_OVERHEAD_FLOOR_W', clamp: { min: 0, max: 1500 }, doc: 'Pool standby overhead floor (W), clamped; decimals accepted (schema float(0,1500)?).', parse: numClamped(270, 0, 1500) }),
  row({ name: 'RUNWAY_CORE_OVERHEAD_W', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:RUNWAY_CORE_OVERHEAD_W', clamp: { min: 0, max: 500 }, doc: 'Per-Core standby overhead (W), clamped; decimals accepted (schema float(0,500)?).', parse: numClamped(90, 0, 500) }),
  row({ name: 'RUNWAY_DRAIN_MARGINAL_EFFICIENCY', source: 'env-only', canonicalReader: 'analytics.ts:RUNWAY_DRAIN_MARGINAL_EFFICIENCY', clamp: { min: 0.8, max: 1 }, doc: 'Marginal drain efficiency, clamped.', parse: numClamped(0.94, 0.8, 1) }),
  row({ name: 'RUNWAY_DISCHARGE_EFFICIENCY', source: 'env-only', canonicalReader: 'analytics.ts:RUNWAY_DISCHARGE_EFFICIENCY', clamp: { min: 0.8, max: 1 },
    doc: 'Discharge-leg efficiency, clamped to 0.8..1; blank or NaN reads as 0.94 through `|| 0.94`.', parse: (raw) => Math.min(1, Math.max(0.8, Number(raw ?? 0.94) || 0.94)) }),
  row({ name: 'BMS_RESEED_MIN_GAP_WH', source: 'option', exportForm: 'has_value', canonicalReader: 'recorder.ts:3555 RESEED_MIN_GAP_WH', doc: 'Floor-vs-live gap that re-seeds the lifetime floors (about one Core\'s capacity). Bare Number(); schema int?.', parse: numOr(50_000) }),
  row({ name: 'BMS_RESEED_SUSTAINED_ROLLUPS', source: 'env-only', canonicalReader: 'recorder.ts:3559 RESEED_SUSTAINED_ROLLUPS', doc: 'Rollups the gap must persist before repairing. Bare Number().', parse: numOr(2) }),
  row({ name: 'GRID_CO2_INTENSITY_LB_PER_MWH', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:DEFAULT_GRID_CO2_LB_PER_MWH', doc: 'Grid carbon intensity (lb CO2 per MWh) for the avoided-CO2 figures. Bare Number(); schema float?.', parse: numOr(1100) }),
  row({ name: 'CYCLING_BASE_WEAR_USD_PER_KWH', source: 'option', exportForm: 'has_value', canonicalReader: 'index.ts:2215 baseWear', doc: 'Base cycling wear cost per kWh for the MPC, in the TARIFF_CURRENCY unit (the key keeps its USD name). Bare Number(); schema float?.', parse: numOr(0.015) }),
  row({ name: 'FORECAST_NIGHT_START_HOUR', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:FORECAST_NIGHT_START_HOUR', clamp: { min: 0, max: 23 }, doc: 'First hour of the overnight blend band, rounded and clamped (a NaN propagates); schema int(0,23)?.', parse: (raw) => Math.min(23, Math.max(0, Math.round(Number(raw ?? 21)))) }),
  row({ name: 'FORECAST_NIGHT_END_HOUR', source: 'option', exportForm: 'has_value', canonicalReader: 'analytics.ts:FORECAST_NIGHT_END_HOUR', clamp: { min: 0, max: 23 }, doc: 'Last hour of the overnight blend band, rounded and clamped (a NaN propagates); schema int(0,23)?.', parse: (raw) => Math.min(23, Math.max(0, Math.round(Number(raw ?? 5)))) }),
  row({ name: 'SELF_HEAL_MIN_DEVICES', source: 'env-only', canonicalReader: 'sessionSelfHeal.ts:DEFAULT_SELF_HEAL_CONFIG', doc: 'Starved-device quorum for a session self-heal. Bare Number().', parse: numOr(2) }),
  row({ name: 'BATTERY_SOC_MAX_DROP_PCT', source: 'env-only', canonicalReader: 'batterySocAlarm.ts:MAX_PLAUSIBLE_DROP_PCT', doc: 'Largest plausible one-tick SoC fall. Bare Number().', parse: numOr(25) }),
  row({ name: 'CAPACITY_SCALE_MIN', source: 'option', exportForm: 'has_value', canonicalReader: 'poolEnergyBasis.ts:CAPACITY_SCALE_MIN', clamp: { min: 0.5, max: 1 },
    doc: 'Lowest measured capacity scale applied to the panel\'s nameplate energies (runway, forecast, idle-pool check, secondary-panel runway); absent, blank or malformed reads as 0.8; clamped to 0.5..1.',
    parse: numClamped(0.8, 0.5, 1) }),
  row({ name: 'OPPORTUNISTIC_LOADS', source: 'option', exportForm: 'has_value', canonicalReader: 'limits.ts:parseOpportunisticLoads', structuredBy: 'limits.ts:parseOpportunisticLoads',
    doc: 'Curtailment suggestions, id:watts:category[:label] per entry (category pool|ev|water|hvac|other, else other); `none` = no suggestions; absent or no valid entry keeps the built-in list.',
    parse: (raw) => raw }),
  row({ name: 'BATTERY_SOC_LADDER', source: 'option', exportForm: 'has_value', canonicalReader: 'limits.ts:parseSocLadder', structuredBy: 'limits.ts:parseSocLadder',
    doc: 'SoC alarm rungs, pct:tier per entry (pct 1..99, tier low|medium|high|critical); absent or no valid rung keeps 50/40/30/20/15/10/8/4/2.',
    parse: (raw) => raw }),
  row({ name: 'DISPATCH_ROUND_TRIP_EFFICIENCY', source: 'env-only', canonicalReader: 'analytics.ts:DISPATCH_ROUND_TRIP_EFFICIENCY', clamp: { min: 0.8, max: 1 },
    doc: 'Round-trip efficiency for the night-charge sizing, clamped; blank or NaN reads as 0.86 (OWNER DECISION 9 keeps 0.86 beside the MPC 0.9). Its square root is also the charge efficiency the runway, the SoC projections and the night-charge walks apply to a PV surplus (v1.194.0).', parse: (raw) => Math.min(1, Math.max(0.8, Number(raw ?? 0.86) || 0.86)) }),
  row({ name: 'MPC_ROUND_TRIP_EFFICIENCY', source: 'env-only', canonicalReader: 'dispatch/mpc.ts:ROUND_TRIP_EFFICIENCY', doc: 'Round-trip efficiency for the MPC. Bare Number().', parse: numOr(0.9) }),

  // ── Devices (v1.191.0 lane D, S8): schema-only, exported under has_value — absent unless set, so unset = today ──
  row({ name: 'BENCH_SPARE_SNS', source: 'option', exportForm: 'has_value', canonicalReader: 'topology.ts:parseBenchSpareSns', structuredBy: 'topology.ts:parseBenchSpareSns',
    doc: 'Bench-spare serials, comma-separated, or `none`. When set it REPLACES the built-in SPARE_DPU_SNS list as the spare floor (never a union); the roster override still applies on top. Unset or blank: the built-in list.',
    parse: trimmedOrNull() }),
  row({ name: 'DEVICE_ALIASES', source: 'option', exportForm: 'has_value', canonicalReader: 'topology.ts:loadDeviceAliases', structuredBy: 'topology.ts:loadDeviceAliases',
    doc: 'Display names by serial, as a JSON object; merged over <dataRoot>/device-aliases.json, which is merged over the image file. Unreadable JSON is skipped and raises a repair item. Unset or blank: the files alone.',
    parse: trimmedOrNull() }),

  // ── Deployment constants (the image and the run script set these; never the user) ──
  row({ name: 'PORT', source: 'deploy', canonicalReader: 'config.ts:port', doc: 'HTTP port (8787; ingress needs it).', parse: numOr(8787) }),
  row({ name: 'HOST', source: 'deploy', canonicalReader: 'config.ts:host', doc: "Bind address; '::' listens dual-stack.", parse: str('::') }),
  row({ name: 'DB_PATH', source: 'deploy', canonicalReader: 'config.ts:dbPath',
    doc: 'SQLite path; absent reads as /data/ecoflow.db inside the add-on (SUPERVISOR_TOKEN set) and ../data/ecoflow.db elsewhere.',
    parse: (raw, env) => raw ?? (env.get('SUPERVISOR_TOKEN') ? '/data/ecoflow.db' : '../data/ecoflow.db') }),
  row({ name: 'DATA_DIR', source: 'deploy', canonicalReader: 'index.ts:527 DATA_DIR', doc: "The add-on's /data root for files not placed beside the database.", parse: str('/data') }),
  row({ name: 'WEB_DIST_PATH', source: 'deploy', canonicalReader: 'index.ts:498 WEB_DIST_PATH', doc: 'Built web bundle; absent resolves ../../web/dist from the server source.', parse: (raw) => raw }),
  row({ name: 'SSH_HOST', source: 'deploy', canonicalReader: 'config.ts:ssh.host', doc: "SSH console bind address (the run script exports the literal `::`, dual-stack); absent reads as `::`.", parse: sshField('SSH_HOST', 'host') }),
  row({ name: 'SSH_HOST_KEY', source: 'deploy', canonicalReader: 'config.ts:ssh.hostKeyPath', doc: 'Path of the ed25519 host key, generated on first start; the run script exports /data/ssh_host_ed25519_key.', parse: sshField('SSH_HOST_KEY', 'hostKeyPath') }),
  row({ name: 'TZ', source: 'deploy', canonicalReader: 'siteTime.ts:resolveSiteTimeZone',
    doc: "The container's zone; the Supervisor sets it to Home Assistant's. The site clock's second source (after SITE_TIMEZONE, before the America/Phoenix default); trimmed, blank reads as unset.",
    parse: trimmedOrNull() }),
  row({ name: 'SUPERVISOR_TOKEN', source: 'deploy', canonicalReader: 'config.ts:isAddon', doc: 'Injected by the Supervisor; its presence means the process runs inside the add-on.', readerView: (v) => !!v, parse: (raw) => raw }),
  row({ name: 'BUILD_VERSION', source: 'deploy', canonicalReader: 'index.ts:779 BUILD_VERSION', doc: "Image version; blank reads as 'dev'.", parse: strOr('dev') }),
  row({ name: 'BUILD_DATE', source: 'deploy', canonicalReader: 'index.ts:780 BUILD_DATE', doc: 'Image build date, or null.', parse: (raw) => raw || null }),
  row({ name: 'BUILD_REF', source: 'deploy', canonicalReader: 'index.ts:781 BUILD_REF', doc: 'Image git ref, or null.', parse: (raw) => raw || null }),
];

export const OPTIONS: Readonly<Record<string, OptionRow>> = Object.freeze(Object.fromEntries(ROWS.map((r) => [r.name, r])));

/**
 * Where a row's value differs from what the shipped `options:` default gives, and why. Kinds:
 *   unset — the value when the variable is absent differs from the value when the default is exported
 *           (never reached on the add-on, which exports every key);
 *   blank — a cleared optional field ('' export) does not read as the default;
 *   null  — a cleared optional field exported as the literal 'null' does not read as the default;
 *   clamp — the row's clamp differs from the schema range.
 * optionsDefaultParity.test.ts requires every difference to be listed here, and every entry to be real.
 */
export interface DeclaredDivergence {
  key: string;
  kind: 'unset' | 'blank' | 'null' | 'clamp';
  code: string;
  yaml: string;
  reason: string;
}

const NULL_LITERAL = "a cleared optional field reaches the process as the string 'null', which this reader takes literally (per-key rule kept; gridState.ts floorSlackPct is the one reader that treats 'null' as unset)";

export const DECLARED_DIVERGENCES: readonly DeclaredDivergence[] = [
  { key: 'SSH_ENABLED', kind: 'unset', code: 'on', yaml: 'false', reason: "`!== '0'`: absent reads as on (a bare development environment keeps the console on, as it did before v1.190.0); the run script always exports 1 or 0. The alignment to off-when-unset waits for CA8 (tests importing config without setting it)" },
  { key: 'BROADCAST_QUIET_HOURS', kind: 'unset', code: 'no window', yaml: '"22-06"', reason: "`?? ''`: absent reads as no quiet window; never reached on the add-on. Aligning it needs CA8 (31 broadcast-importing tests would start depending on the wall clock)" },
  { key: 'BROADCAST_QUIET_HOURS', kind: 'blank', code: 'no window', yaml: '"22-06"', reason: 'a cleared field disables the audible quiet window; index.ts quietConfigured reads the same blank as "quiet hours not configured"' },
  { key: 'BROADCAST_QUIET_HOURS', kind: 'null', code: 'no window', yaml: '"22-06"', reason: "'null' is not HH-HH, so the window is off" },
  { key: 'NOTIFY_QUIET_HOURS', kind: 'blank', code: 'no window', yaml: '"22-06"', reason: 'a cleared field disables the quiet window; index.ts quietConfigured reads the same blank as "quiet hours not configured"' },
  { key: 'NOTIFY_QUIET_HOURS', kind: 'null', code: 'no window', yaml: '"22-06"', reason: "'null' is not HH-HH, so the window is off" },
  { key: 'BROADCAST_BILINGUAL', kind: 'unset', code: 'on', yaml: 'false', reason: "OWNER DECISION 21: the shipped default is off, so a new install speaks English only until the Spanish pass is turned on; a stored configuration keeps its value. `notFalseNot0`: absent still reads as on (the run script always exports true or false). Aligning the unset value waits for CA8 (tests importing broadcast.ts without setting it)" },
  { key: 'BROADCAST_LEAD_SILENCE_MS', kind: 'unset', code: '1500', yaml: '1000', reason: 'raised in code when 1000 clipped chimes; OWNER DECISION 7 keeps 1500 in code and 1000 in the shipped default' },
  { key: 'BROADCAST_LEAD_SILENCE_MS', kind: 'blank', code: '1500', yaml: '1000', reason: 'a cleared field takes the code fallback 1500, not the shipped 1000' },
  { key: 'BROADCAST_LEAD_SILENCE_MS', kind: 'null', code: '1500', yaml: '1000', reason: "'null' is not finite, so the code fallback 1500 applies" },
  { key: 'BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN', kind: 'blank', code: '1 min', yaml: '60', reason: "`Math.max(1, Number(''))`: a cleared field reads as the 1-minute floor" },
  { key: 'BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN', kind: 'null', code: 'NaN', yaml: '60', reason: "`Number('null')` is NaN and Math.max does not floor it" },
  { key: 'BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN', kind: 'clamp', code: '≥ 1', yaml: 'int(5,720)?', reason: 'the code floors at 1 minute and has no ceiling; HA validates 5..720' },
  { key: 'MQTT_DISCOVERY_HOST', kind: 'unset', code: 'undefined', yaml: '""', reason: "the reader passes the raw string through: absent is undefined where the exported default is ''; never reached on the add-on, which exports every key" },
  { key: 'MQTT_DISCOVERY_USER', kind: 'unset', code: 'undefined', yaml: '""', reason: "the reader passes the raw string through: absent is undefined where the exported default is ''; never reached on the add-on, which exports every key" },
  { key: 'MQTT_DISCOVERY_PASS', kind: 'unset', code: 'undefined', yaml: '""', reason: "the reader passes the raw string through: absent is undefined where the exported default is ''; never reached on the add-on, which exports every key" },
  { key: 'MQTT_DISCOVERY_PREFIX', kind: 'blank', code: "''", yaml: 'homeassistant', reason: 'a blank prefix passes through (`??` does not catch it)' },
  { key: 'MQTT_DISCOVERY_PREFIX', kind: 'null', code: "'null'", yaml: 'homeassistant', reason: NULL_LITERAL },
  { key: 'NOTIFY_DIGEST_HOUR', kind: 'blank', code: '0', yaml: '7', reason: "`Number('')` is 0: a cleared field sends the digest at midnight" },
  { key: 'NOTIFY_DIGEST_HOUR', kind: 'null', code: 'NaN', yaml: '7', reason: "`Number('null')` is NaN (guarded downstream at alertMonitor.ts ~4000)" },
  { key: 'NOTIFY_DIGEST_HOUR', kind: 'clamp', code: 'none', yaml: 'int(0,23)?', reason: HA_SCHEMA_VALIDATES },
  { key: 'NIGHT_CHARGE_NOTIFY_HOUR', kind: 'clamp', code: '0..22', yaml: 'int(0,23)', reason: 'the evening job runs only until 23:00 on the APS preset, so hour 23 is clamped to 22; another plan clamps further, to the hour before its cheap window opens (W6, nightSchedule.ts notifyHourMax)' },
  { key: 'HEARTBEAT_URL', kind: 'null', code: 'configured', yaml: '""', reason: "'null' reads as a configured (then rejected) URL: the heartbeat logs one warning and stays off" },
  { key: 'BROADCAST_AUDIO_BASE', kind: 'null', code: "'null'", yaml: 'http://homeassistant.local:8787', reason: NULL_LITERAL },
  { key: 'BROADCAST_WYOMING_HOST', kind: 'null', code: "'null'", yaml: 'core-piper', reason: NULL_LITERAL },
  { key: 'BROADCAST_WYOMING_VOICE', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'BROADCAST_WYOMING_VOICE_ES', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'GRID_PRESENCE_ENTITY', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'HOST_POWER_ENTITY', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'MQTT_DISCOVERY_HOST', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'MQTT_DISCOVERY_USER', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'MQTT_DISCOVERY_PASS', kind: 'null', code: "'null'", yaml: '""', reason: NULL_LITERAL },
  { key: 'TUI_PASSWORD', kind: 'null', code: "'null'", yaml: '""', reason: `${NULL_LITERAL}; the login gate turns on with that password` },
  { key: 'TUI_TRUSTED_ORIGINS', kind: 'null', code: "['null']", yaml: '""', reason: NULL_LITERAL },
  { key: 'NOTIFY_HA_PUSH_TARGETS', kind: 'null', code: "['null']", yaml: '""', reason: NULL_LITERAL },
  { key: 'LOAD_SHEDDING_SHED_ENTITIES', kind: 'null', code: "'null'", yaml: '""', reason: `${NULL_LITERAL}; loadShedRegistry drops the entry because it has no dot` },
  { key: 'ECOFLOW_DEVICE_REACHABILITY', kind: 'null', code: "'null'", yaml: '""', reason: `${NULL_LITERAL}; deviceLink.ts parses JSON null as an empty map` },
  { key: 'WRITE_DEBUG_TOKEN', kind: 'null', code: "'null'", yaml: '""', reason: `${NULL_LITERAL}; the debug write endpoint unlocks with that token` },
  // Schema ranges the code does not enforce (HA validates the form; a hand-set environment is not clamped).
  ...(['FORECAST_LAT', 'FORECAST_LON', 'ARB_OUTAGE_CUSHION_PCT', 'ARB_OUTAGE_CUSHION_HOURS', 'ARB_ISLANDED_LOAD_SAFETY', 'ARB_COST_MAX_SOC_PCT',
    'ARB_MIN_BUY_KWH', 'ARB_CHARGE_CAP_KW', 'ARB_GRID_INPUT_CAP_KW', 'ARB_LOAD_P90_FACTOR', 'LOAD_SHEDDING_RUNWAY_THRESHOLD_H', 'LOAD_SHEDDING_RESTORE_MARGIN_H'] as const)
    .map((key): DeclaredDivergence => ({ key, kind: 'clamp', code: 'none', yaml: 'ranged', reason: HA_SCHEMA_VALIDATES })),
];

/* ───────────────────────────── reading ───────────────────────────── */

const env: Env = { get: (name) => process.env[name] };

/**
 * v1.191.0 — the raw exported string of a registered option (undefined when absent), for a reader that
 * combines keys (an alias: the two_tier plan reads TARIFF_ON_PEAK_CENTS, else TARIFF_ON_PEAK_CENTS_PER_KWH,
 * whose own rows apply each path's rule). The variable is still read here, the one module that reads it.
 */
export function optionRaw(name: string): string | undefined {
  if (!OPTIONS[name]) throw new Error(`config: ${name} is not a registered option`);
  return process.env[name];
}

/** The current value of a registered option, parsed by its row. Read at call time. */
export function option<T = unknown>(name: string): T {
  const r = OPTIONS[name];
  if (!r) throw new Error(`config: ${name} is not a registered option`);
  return r.parse(process.env[name], env) as T;
}

function lazyRequired(name: string): { get value(): string } {
  let cached: string | undefined;
  return {
    get value(): string {
      if (cached !== undefined) return cached;
      cached = option<string>(name);
      return cached;
    },
  };
}

const _accessKey = lazyRequired('ECOFLOW_ACCESS_KEY');
const _secretKey = lazyRequired('ECOFLOW_SECRET_KEY');
const dbPath = option<string>('DB_PATH');

export const config = {
  /** Throws on first access if ECOFLOW_ACCESS_KEY isn't set. */
  get accessKey(): string {
    return _accessKey.value;
  },
  /** Throws on first access if ECOFLOW_SECRET_KEY isn't set. */
  get secretKey(): string {
    return _secretKey.value;
  },
  apiHost: option<string>('ECOFLOW_API_HOST'),
  port: option<number>('PORT'),
  // `::` makes Fastify listen dual-stack (IPv4 + IPv6 on one socket; Node
  // does NOT set IPV6_V6ONLY). `0.0.0.0` is IPv4 only — clients that resolve
  // a hostname to its IPv6 address (which macOS does by default for `.local`)
  // hit the host's IPv6 stack with no listener and the connection is RST'd.
  // Same fix as v0.3.1 applied to the LAN console bind.
  host: option<string>('HOST'),
  // v1.7.2 — when unset, default to an ABSOLUTE /data path inside the HA add-on
  // container (SUPERVISOR_TOKEN is always injected there) so a dropped DB_PATH
  // export can never silently redirect state writes to /app/data (cwd is
  // /app/server) — which the v1.7.2 AppArmor `deny /app/{,**} wal` rule would then
  // block, aborting startup. Outside the container (dev/tests) the relative
  // default is unchanged; every test sets DB_PATH explicitly regardless.
  dbPath,
  logLevel: option<string>('LOG_LEVEL'),
  // Location for solar weather forecasting (defaults to the placeholder, Phoenix, AZ).
  forecastLat: option<number>('FORECAST_LAT'),
  forecastLon: option<number>('FORECAST_LON'),
  // SSH control-room TUI — a menu-driven terminal view of the whole fleet; see
  // resolveSshConfig() above (the SSH_* rows of OPTIONS call the same resolver, so a
  // row and this value cannot disagree).
  // Default host is `::` (Node dual-stack — accepts both IPv4 and IPv6 on one
  // socket; Node does NOT set IPV6_V6ONLY, so IPv4 still works via mapped
  // addresses). Listening only on `0.0.0.0` would silently break clients that
  // resolve `homeassistant.local` to its IPv6 address (which macOS does by
  // default) — they'd connect to the host's IPv6 stack and get a TCP RST.
  ssh: resolveSshConfig(),
  /** RECORDER_RETENTION_DAYS: raw-sample retention in days, rounded and clamped to 7..3650 (30 when
   *  absent, blank or malformed). Read at call time, as its five readers did (retention.ts
   *  resolveRetentionDays is the same rule, pinned by golden G3 and G8). */
  get retentionDays(): number {
    return option<number>('RECORDER_RETENTION_DAYS');
  },
  /** True inside the add-on container (the Supervisor injects SUPERVISOR_TOKEN). Read at call time. */
  get isAddon(): boolean {
    return !!option<string | undefined>('SUPERVISOR_TOKEN');
  },
  /** The directory beside the database: where the state files live (`resolve(cwd, dbPath, '..')` today, 46 copies). */
  get dataRoot(): string {
    return resolve(process.cwd(), dbPath, '..');
  },
  /** The add-on's /data root used by the handful of files that are not placed beside the database (DATA_DIR ?? '/data'). */
  get dataDir(): string {
    return option<string>('DATA_DIR');
  },
  /**
   * A state file beside the database, or the explicit override a `*_PATH` variable carries. Pass the
   * override's VALUE (the caller's own `*_PATH` row), not its name: `config.dataFile('grid-reading.json', option('GRID_READING_PATH'))`.
   */
  dataFile(name: string, override?: string | null): string {
    return override || resolve(process.cwd(), dbPath, '..', name);
  },
};

// v1.191.0 (lane D) — topology.ts reads BENCH_SPARE_SNS and DEVICE_ALIASES through this table without
// importing this module (see topology.ts "option access": an import there would move this module's
// first-load capture of DB_PATH earlier in every process that loads the device modules).
bindTopologyOptions({ option, dataFile: (name) => config.dataFile(name) });
