/**
 * topology.ts — discovered or configured plant topology (plan 2.6): `productKind()`, `coreNumber()`,
 * alias loading and the effective bench-spare floor (BENCH_SPARE_SNS replaces the literal when set;
 * OWNER DECISION 1).
 *
 * v1.191.0 (S8, lane D). Everything here resolves from the environment and the files alone, so the
 * main thread and the analytics worker compute the same answers (CA17); the one runtime-derived input
 * the spare floor honours, the last-known home roster, stays in shp2Membership.ts and the worker is
 * sent it the way the owner reserve floor is. The SPARE_DPU_SNS literal in shp2Membership.ts is never
 * edited: shp2Membership passes it in as the fallback, so this module never names a serial.
 *
 * Unset, every answer is today's:
 *   - the spare floor is the literal (BENCH_SPARE_SNS absent);
 *   - the display aliases are the image file's alone (no /data file, no DEVICE_ALIASES);
 *   - a Core's number comes from its name by the same pattern chain the three copies used;
 *   - a product is told apart by the same lower-cased substring tests the nineteen inline sites used.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* ───────────────────────────── option access ───────────────────────────── */

/**
 * The two options this module reads (BENCH_SPARE_SNS, DEVICE_ALIASES) and the data root, reached through
 * config.ts — the only reader of the environment — which binds its `option()` here when it loads
 * (bindTopologyOptions, at the end of config.ts). topology.ts does not import config.ts: config.ts
 * captures its deployment values (DB_PATH among them) when it is first imported, and the modules that
 * now call into this file (shp2Membership.ts, ecoflow/project.ts, analytics/mathHelpers.ts, the console)
 * never imported it, so an import here would move that capture earlier in every process that loads
 * them. Until config.ts has loaded nothing is configured: the built-in spare list and the image's alias
 * file apply, today's behaviour. In the add-on config.ts loads first (index.ts, and the analytics
 * worker's own module graph).
 */
export interface TopologyOptionAccess {
  option<T = unknown>(name: string): T;
  /** A state file beside the database (config.dataFile). */
  dataFile(name: string): string;
}
let access: TopologyOptionAccess | null = null;

/** config.ts hands over its option reader (once, when it loads). */
export function bindTopologyOptions(a: TopologyOptionAccess): void { access = a; }

/* ───────────────────────────── product identification ───────────────────────────── */

/**
 * What kind of device a product name describes. One helper for the substring tests that were written
 * out inline (ecoflow/project.ts projectByProduct, snapshot.ts, shp2Membership.ts, alerts.ts,
 * repairIssues.ts, gridState.ts, ecoflow/mqtt.ts, console/plant/data.ts, index.ts): the name is
 * lower-cased and searched for `delta pro ultra` (a DELTA Pro Ultra, "Core") and `smart home panel`
 * (the Smart Home Panel 2; the first-generation panel matches too — plan section 8). A name holding
 * both is a DPU, the order projectByProduct always tested in. A site that asked only one question
 * calls the predicate for that question, so its answer is unchanged for every string.
 *
 * When the cloud omits `productName`, snapshot.ts guesses one from the display name
 * (guessProductFromName) and keeps its rule that a name starting `core ` is a DELTA Pro Ultra.
 */
export type ProductKind = 'dpu' | 'shp2' | 'other';

/** `productName` names a DELTA Pro Ultra (case-insensitive substring `delta pro ultra`). */
export function isDpuProduct(productName: string | null | undefined): boolean {
  return (productName ?? '').toLowerCase().includes('delta pro ultra');
}

/** `productName` names a Smart Home Panel (case-insensitive substring `smart home panel`). */
export function isShp2Product(productName: string | null | undefined): boolean {
  return (productName ?? '').toLowerCase().includes('smart home panel');
}

export function productKind(productName: string | null | undefined): ProductKind {
  if (isDpuProduct(productName)) return 'dpu';
  if (isShp2Product(productName)) return 'shp2';
  return 'other';
}

/* ───────────────────────────── Core numbering ───────────────────────────── */

/**
 * The noun a DELTA Pro Ultra is called by in runtime text ("Core 3"). OWNER DECISION 6 keeps "Core"
 * as the label; text built in this lane's files names it through here rather than writing it out.
 */
export const DPU_LABEL = 'Core';

/** The serial-tail disambiguator `disambiguatedName` appends: ` (…0489)`. */
const SERIAL_TAIL_SUFFIX = /\s*\(…[0-9A-Za-z]{1,8}\)$/;

/**
 * A Core's number from its display name: `core N` anywhere (case-insensitive), else the first run of
 * digits, else null. The chain the three copies used (alerts.ts dpuNum, analytics/mathHelpers.ts
 * dpuNum, console/plant/data.ts dpuNum and generatorNumber, the last two with their own fallbacks).
 * A serial-tail disambiguator this module appended is not read as a number.
 */
export function coreNumberFromName(name: string | null | undefined): number | null {
  if (typeof name !== 'string') return null;
  const n = name.replace(SERIAL_TAIL_SUFFIX, '');
  const m = n.match(/core\s*(\d+)/i) ?? n.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The fields `coreNumber` reads. `nameFallback` is set by the snapshot store (snapshot.ts). */
export interface NamedDevice {
  sn: string;
  deviceName: string;
  /** The display name came from the product-name or serial fallback: the owner never named it. */
  nameFallback?: boolean;
}

/** The structural shape of a panel `slotOfDpu` reads (a DeviceSnapshot with an SHP2 projection). */
interface PanelLike {
  sn: string;
  projection?: { kind: string; sources?: ReadonlyArray<{ slot: number; sn: string | null; isConnected?: boolean }> } | null;
}

/**
 * The panel slot a DPU sits in (1-based), from the panels' source lists: a connected listing first,
 * then any listing, each on the panel with the lowest serial first. Null when no panel lists it.
 */
export function slotOfDpu(devices: Readonly<Record<string, unknown>> | null | undefined, sn: string): number | null {
  if (!devices) return null;
  const panels = (Object.values(devices) as PanelLike[])
    .filter((d) => d?.projection?.kind === 'shp2')
    .sort((a, b) => (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));
  for (const connectedOnly of [true, false]) {
    for (const p of panels) {
      for (const s of p.projection?.sources ?? []) {
        if (s.sn === sn && (!connectedOnly || s.isConnected === true)) return s.slot;
      }
    }
  }
  return null;
}

/**
 * A Core's number. A DPU the owner named is numbered from its name (coreNumberFromName, identical
 * for every "Core N" name). A DPU still under its product-name fallback (CA4: the store keeps
 * "DELTA Pro Ultra" rather than its serial) has no number in its name, so its panel slot numbers it;
 * a fallback-named DPU on no panel has no number (null), and the text that labels it uses its
 * display name instead (coreLabel). Never the digits of a serial.
 */
export function coreNumber(d: NamedDevice, devices?: Readonly<Record<string, unknown>> | null): number | null {
  if (d.nameFallback === true) return slotOfDpu(devices, d.sn);
  return coreNumberFromName(d.deviceName);
}

/** "Core 3" when the number is known, else the device's display name (never "Core null"). */
export function coreLabel(coreNum: number | null | undefined, fallbackName: string): string {
  return coreNum != null && Number.isFinite(coreNum) ? `${DPU_LABEL} ${coreNum}` : fallbackName;
}

/* ───────────────────────────── display names ───────────────────────────── */

/** `base` with its disambiguator: the panel slot when known, else the serial's last four characters. */
export function disambiguatedName(base: string, o: { sn: string; slot: number | null }): string {
  if (o.slot != null) return `${base} (slot ${o.slot})`;
  return `${base} (…${o.sn.slice(-4)})`;
}

/**
 * CA4 — two devices the owner never named both resolve to their product name ("DELTA Pro Ultra"),
 * and every alert, card and log line then names two units identically. Each FALLBACK-named entry
 * whose name another entry also carries gets a disambiguator (disambiguatedName). An owner-chosen
 * name (the cloud name, or an alias) is never altered, so on a plant whose devices are all named
 * nothing changes. Returns the names to use, by serial.
 */
export function disambiguateFallbackNames(
  entries: ReadonlyArray<{ sn: string; name: string; fallback: boolean }>,
  slotOf: (sn: string) => number | null,
): Map<string, string> {
  const count = new Map<string, number>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.sn)) continue; // a serial listed twice is one device
    seen.add(e.sn);
    count.set(e.name, (count.get(e.name) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    out.set(e.sn, e.fallback && (count.get(e.name) ?? 0) > 1 ? disambiguatedName(e.name, { sn: e.sn, slot: slotOf(e.sn) }) : e.name);
  }
  return out;
}

/* ───────────────────────────── display aliases ───────────────────────────── */

export type AliasSource = 'image' | 'data' | 'option';

export interface AliasLoad {
  /** serial → display name, merged: the option over the /data file over the image file. */
  aliases: Record<string, string>;
  /** Which layer each serial's alias came from. */
  sourceBySn: Record<string, AliasSource>;
  /** A layer that is present but unreadable (the option, or the /data file): it is skipped. */
  errors: Array<{ source: AliasSource; message: string }>;
}

/**
 * One alias layer: a JSON object of serial → name, either flat (`{"<serial>":"Core 5"}`, the
 * DEVICE_ALIASES form) or under `aliases` (the files' form, `{"aliases":{…}}`). Entries whose name
 * is not a non-blank string are dropped. Throws on text that is not a JSON object.
 */
export function parseAliasMap(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  const inner = (parsed as { aliases?: unknown }).aliases;
  const map = inner != null && typeof inner === 'object' && !Array.isArray(inner) ? inner : parsed;
  const out: Record<string, string> = {};
  for (const [sn, name] of Object.entries(map as Record<string, unknown>)) {
    if (sn.trim() === '' || sn.startsWith('_')) continue; // `_comment` in the image file
    if (typeof name !== 'string' || name.trim() === '') continue;
    out[sn.trim()] = name;
  }
  return out;
}

/** The image's alias file (server/device-aliases.json, read from the working directory as before). */
export const imageAliasPath = (): string => resolve(process.cwd(), 'device-aliases.json');
/** The owner's alias file beside the database (`/data/device-aliases.json` in the add-on); null until
 *  config.ts has loaded. */
export const dataAliasPath = (): string | null => access?.dataFile('device-aliases.json') ?? null;

/**
 * The display aliases (3.11): DEVICE_ALIASES (JSON) merged over `<dataRoot>/device-aliases.json`,
 * merged over the image file. Each layer wins per serial over the ones below it. A missing file is
 * no layer; an unreadable /data file or option is reported in `errors` and skipped (fail closed: the
 * layers below still apply). With neither the option nor the /data file, this is the image file
 * alone — today's behaviour. The image file's own errors are silent, as before.
 */
export function loadDeviceAliases(o: { imagePath?: string; dataPath?: string; optionRaw?: string | null } = {}): AliasLoad {
  const aliases: Record<string, string> = {};
  const sourceBySn: Record<string, AliasSource> = {};
  const errors: AliasLoad['errors'] = [];
  const layer = (source: AliasSource, text: string | null): void => {
    if (text == null) return;
    try {
      for (const [sn, name] of Object.entries(parseAliasMap(text))) { aliases[sn] = name; sourceBySn[sn] = source; }
    } catch (e) {
      // A SyntaxError's message quotes the text it failed on; the text is the owner's serials.
      if (source !== 'image') errors.push({ source, message: e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message });
    }
  };
  const read = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  const imagePath = o.imagePath ?? imageAliasPath();
  const dataPath = o.dataPath ?? dataAliasPath();
  layer('image', read(imagePath));
  if (dataPath != null && resolve(dataPath) !== resolve(imagePath)) layer('data', read(dataPath));
  const raw = o.optionRaw !== undefined ? o.optionRaw : access?.option<string | null>('DEVICE_ALIASES') ?? null;
  if (raw != null && raw.trim() !== '') layer('option', raw);
  return { aliases, sourceBySn, errors };
}

let aliasMemo: AliasLoad | null = null;

/**
 * The aliases in force for this process: loaded once, on first use (snapshot.ts reads them when it
 * loads, as it read the image file before), so every reader sees the same merge. A changed option or
 * /data file applies from the next start.
 */
export function deviceAliases(): AliasLoad {
  if (aliasMemo == null) aliasMemo = loadDeviceAliases();
  return aliasMemo;
}

/** Test seam: forget the loaded aliases so the next deviceAliases() call reads the layers again. */
export function resetDeviceAliasesForTesting(): void { aliasMemo = null; }

/* ───────────────────────────── bench spares (OWNER DECISION 1) ───────────────────────────── */

/**
 * BENCH_SPARE_SNS → the configured spare set: a comma list of serials (trimmed, upper-cased, blanks
 * dropped), or `none` for no spares (an empty set). Null when the option is unset or blank: then the
 * SPARE_DPU_SNS literal is the floor, as today.
 */
export function parseBenchSpareSns(raw: string | null | undefined): ReadonlySet<string> | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '') return null;
  if (t.toLowerCase() === 'none') return new Set();
  return new Set(t.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0));
}

let spareMemo: { raw: string | null; set: ReadonlySet<string> | null } | null = null;

/** The configured bench-spare set (BENCH_SPARE_SNS), or null while it is unset. Read at call time. */
export function configuredBenchSpareSns(): ReadonlySet<string> | null {
  const raw = access?.option<string | null>('BENCH_SPARE_SNS') ?? null;
  if (spareMemo == null || spareMemo.raw !== raw) spareMemo = { raw, set: parseBenchSpareSns(raw) };
  return spareMemo.set;
}

/** Is BENCH_SPARE_SNS set? While it is not, /api/site withholds the per-DPU `benchSpare` flag and the
 *  web keeps today's rule (plan 3.8 S3). */
export function benchSpareOptionSet(): boolean {
  return configuredBenchSpareSns() != null;
}

/**
 * The effective bench-spare floor: BENCH_SPARE_SNS when it is set, REPLACING `literal` (never a
 * union: a union would keep a stale literal entry — a Core since wired into a panel — in the floor,
 * where a cloud-dark panel leaves the literal consulted alone and that Core's genuine offline alarm
 * muted); `literal` otherwise. shp2Membership.ts reads it at every place it read the literal (CA5).
 */
export function effectiveBenchSpareFloor(literal: ReadonlySet<string>): ReadonlySet<string> {
  return configuredBenchSpareSns() ?? literal;
}

/* ───────────────────────────── warranty export (3.16, X1) ───────────────────────────── */

export type WarrantyChassis =
  | { sn: string; via: 'query' | 'legacy-default' | 'latched' }
  | { error: string; candidates: string[] };

/**
 * Which chassis /api/warranty-export reports on when no `?sn=` is given: the legacy default when it is
 * on this account's device map (this install: unchanged), else the chassis holding the one latched
 * defective pack when exactly one chassis holds any, else none — and the caller answers 400 with
 * the last four characters of each Core's serial, so the operator can pick one.
 */
export function warrantyChassis(
  querySn: string | undefined,
  legacyDefault: string,
  devices: Readonly<Record<string, { sn: string; productName?: string | null }>>,
  latchedDeviceSns: readonly string[],
): WarrantyChassis {
  if (querySn != null) return { sn: querySn, via: 'query' };
  if (devices[legacyDefault] != null) return { sn: legacyDefault, via: 'legacy-default' };
  const latched = [...new Set(latchedDeviceSns)];
  if (latched.length === 1) return { sn: latched[0], via: 'latched' };
  const candidates = Object.values(devices)
    .filter((d) => isDpuProduct(d.productName))
    .map((d) => `…${d.sn.slice(-4)}`)
    .sort();
  return {
    error: latched.length > 1
      ? 'more than one chassis holds a latched defective pack: pass ?sn=<chassis serial>'
      : 'no default chassis on this account: pass ?sn=<chassis serial>',
    candidates,
  };
}
