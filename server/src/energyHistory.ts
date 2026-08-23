/**
 * energyHistory.ts — v1.82.0. The vendor's own energy ledger, fetched daily and
 * reconciled against the local accumulators.
 *
 * WHY: the local lifetime/day counters integrate live samples, so add-on
 * downtime (deploys, host reboots, the 89.4h recorder blackout of 07-29) leaves
 * holes that nothing could audit. The PD303 historical-data endpoint
 * (`POST /iot-open/sign/device/quota/data`, documented 2026-08-17) serves the
 * SHP2's OWN daily energy totals — home, grid, solar, generator, battery
 * in/out — plus a per-circuit split by SOURCE (grid / generator / battery)
 * that the add-on cannot compute locally at all.
 *
 * DESIGN CONSTRAINTS
 *  - READ-ONLY vendor surface; one batch per day (~19 sequential requests with
 *    spacing) — this must never compete with the alarm path's REST budget.
 *  - Reconciliation compares LIKE BASES ONLY: vendor "home" ↔ local
 *    panelLoadWh and vendor "solar" ↔ local pvWh. Vendor grid / generator /
 *    battery are RECORDED but not scored against local numbers whose basis
 *    differs (the two-grid-quantities trap: DPU ac_in vs SHP2 gridWatt).
 *  - Vendor values are treated as claims, not truth: the record stores both
 *    sides and the drift, and drift is surfaced in the log — no alert, no
 *    alarm-path coupling, until a baseline of agreement is established.
 *  - Times sent to the endpoint are device-local (the SHP2 lives in
 *    America/Phoenix). Formatted manually — never Intl on the Pi image.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';
import { ecoflow } from './ecoflow/rest.js';

/* ─── vendor request codes (PD303 doc, verbatim) ──────────────────────────── */

export const VENDOR_FLOW_CODES = {
  homeWh: 'PD303-App-LOAD-LOAD-ENERGY-FLOW-chart_general_value_no_filt-Week',
  gridWh: 'PD303-App-GRID-GRID-ENERGY-FLOW-chart_grid_value-Week',
  solarWh: 'PD303-App-SOLAR-SOLAR-ENERGY-FLOW-chart_general_value_no_filt-Week',
  generatorWh: 'PD303-App-GENERATOR-GENERATOR-ENERGY-FLOW-chart_general_value_no_filt-Week',
} as const;
export const VENDOR_BATTERY_CODE =
  'PD303-App-BATTERY-BATTERY-ENERGY-FLOW-chart_battery_value_dual-Week';
export const VENDOR_CIRCUIT_CODE = 'PD303-Dashboard-Circuits-Line-Week';

/* ─── shapes ──────────────────────────────────────────────────────────────── */

export interface VendorCircuitDay {
  circuit: number; // 1-12
  gridWh: number;
  generatorWh: number;
  batteryWh: number;
}

export interface VendorDayRecord {
  day: string; // YYYY-MM-DD, Phoenix
  fetchedAtMs: number;
  homeWh: number | null;
  gridWh: number | null;
  solarWh: number | null;
  generatorWh: number | null;
  batteryInWh: number | null;
  batteryOutWh: number | null;
  circuits: VendorCircuitDay[];
  /** Like-basis local comparison, when local totals were available at fetch time.
   *  v1.87.0 adds pvCoverage (the fleet PV "% measured" for the same day) so a
   *  structural drift (a cloud-dark Core) is distinguishable from meter
   *  disagreement in the stored record — without it the +47% Core 2 drift was
   *  indistinguishable from vendor error and the baseline could never converge. */
  local: {
    panelLoadWh: number | null; pvWh: number | null; pvCoverage?: number | null;
    /** v1.89.0 — gross pack-DC flows for the same day (local recorder integrals). */
    batteryChargeWh?: number | null; batteryDischargeWh?: number | null;
  } | null;
  /** v1.87.0 — vendorSolarWh − localPvWh when the local basis is PARTIAL
   *  (pvCoverage < 0.95): the implied production of the unmeasured (dark)
   *  capacity — the only production observability for a cloud-dark Core. */
  impliedDarkPvWh?: number | null;
  driftHomePct: number | null;
  driftSolarPct: number | null;
}

/* ─── pure helpers (exported for tests + the harness) ─────────────────────── */

/** Device-local day window strings, manually formatted (no Intl on the Pi). */
export function dayWindow(ymd: string): { beginTime: string; endTime: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`bad day: ${ymd}`);
  return { beginTime: `${ymd} 00:00:00`, endTime: `${ymd} 23:59:59` };
}

/** The endpoint double-nests: outer {code,data:{code,data:[...]}}. Unwrap
 *  defensively — either level missing/failed returns null, never throws. */
export function unwrapDataRows(resp: unknown): Array<Record<string, unknown>> | null {
  if (resp == null || typeof resp !== 'object') return null;
  let node: any = resp;
  // The rest client already strips the OUTER envelope (call() returns .data),
  // so `resp` is usually the inner {code,message,data:[...]} — but tolerate
  // being handed the full envelope too.
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(node)) return node as Array<Record<string, unknown>>;
    if (node?.data === undefined) return null;
    if (node.code !== undefined && String(node.code) !== '0') return null;
    node = node.data;
  }
  return Array.isArray(node) ? (node as Array<Record<string, unknown>>) : null;
}

/** Single-total flow responses: [{indexName:'master_data', indexValue:N, unit:'wh'}]. */
export function parseFlowTotalWh(resp: unknown): number | null {
  const rows = unwrapDataRows(resp);
  if (!rows) return null;
  const row = rows.find((r) => r['indexName'] === 'master_data') ?? rows[0];
  const v = Number(row?.['indexValue']);
  return Number.isFinite(v) ? v : null;
}

/** Battery dual response: extra '1' = input_total_bat, '2' = output_total_bat. */
export function parseBatteryDualWh(resp: unknown): { inWh: number | null; outWh: number | null } {
  const rows = unwrapDataRows(resp);
  if (!rows) return { inWh: null, outWh: null };
  const pick = (extra: string): number | null => {
    const row = rows.find((r) => String(r['extra']) === extra);
    const v = Number(row?.['indexValue']);
    return Number.isFinite(v) ? v : null;
  };
  return { inWh: pick('1'), outWh: pick('2') };
}

/** Per-circuit rows: [{detailGrid:'0', detailBattery:'0', detailGenerator:'0',
 *  time:'2025-05-01'}, …] — STRING numerals per the doc; sum with coercion. */
export function parseCircuitDayWh(resp: unknown, circuit: number): VendorCircuitDay | null {
  const rows = unwrapDataRows(resp);
  if (!rows) return null;
  const sum = (k: string): number =>
    rows.reduce((s, r) => {
      const v = Number(r[k]);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  return {
    circuit,
    gridWh: sum('detailGrid'),
    generatorWh: sum('detailGenerator'),
    batteryWh: sum('detailBattery'),
  };
}

/** Drift %, positive = vendor reads higher. Null unless both sides are
 *  meaningful (>= 100 Wh each — percentage drift on near-zero days is noise). */
export function driftPct(vendorWh: number | null, localWh: number | null): number | null {
  if (vendorWh == null || localWh == null) return null;
  if (vendorWh < 100 || localWh < 100) return null;
  return Math.round(((vendorWh - localWh) / localWh) * 1000) / 10;
}

/* ─── v1.89.0: LOCAL pack-DC round-trip ratio (B2 — the true-RTE ladder's
 * first honest rung). Basis: per-pack in/out recorder integrals on the DC
 * side, so this EXCLUDES charger + inverter conversion losses — it is the
 * battery chemistry + BMS ratio, an UPPER BOUND on the AC dispatch RTE.
 * DISPATCH_RTE (0.86, AC-to-AC) stays assumed until an AC-side basis exists;
 * this series bounds it and watches for degradation trends. ──────────────── */

export interface LocalPackRte {
  sampleDays: number;
  chargeWh: number;
  dischargeWh: number;
  /** discharge/charge over qualifying days; null until >= MIN_RTE_SAMPLE_DAYS. */
  packDcRte: number | null;
  basis: 'pack-dc';
  /** v1.103.0 — days dropped because pool membership was unstable or unrecorded
   *  for that day. Surfaced so a low sampleDays is explainable rather than
   *  mysterious. */
  excludedDays?: number;
}

export const RTE_MIN_DAY_CHARGE_WH = 2_000;

export function computeLocalPackRte(
  days: ReadonlyArray<VendorDayRecord>,
  /** v1.103.0 — days whose pool membership was not stable are excluded. */
  membershipOk?: (day: string) => boolean,
): LocalPackRte {
  let chargeWh = 0, dischargeWh = 0, sampleDays = 0, excludedDays = 0;
  for (const d of days) {
    const c = d.local?.batteryChargeWh, x = d.local?.batteryDischargeWh;
    if (c == null || x == null) continue;
    if (c < RTE_MIN_DAY_CHARGE_WH) continue; // no meaningful charge = ratio noise
    // v1.103.0 — a day whose pool membership CHANGED (or is unrecorded) measures
    // its charge and discharge legs over DIFFERENT sets of batteries, so the
    // ratio is meaningless. After the 2026-08-20 swap this accumulated 77,218 Wh
    // in against 92,676 Wh out — a "round-trip efficiency" of 1.20, which is
    // physically impossible and was quietly poisoning every future sample.
    if (membershipOk != null && !membershipOk(d.day)) { excludedDays++; continue; }
    sampleDays++; chargeWh += c; dischargeWh += x;
  }
  return {
    sampleDays, chargeWh, dischargeWh, basis: 'pack-dc', excludedDays,
    packDcRte: sampleDays >= MIN_RTE_SAMPLE_DAYS && chargeWh > 0
      ? Math.round((dischargeWh / chargeWh) * 1000) / 1000
      : null,
  };
}

/* ─── v1.90.0 (B7): the morning digest's ledger line ──────────────────────── */

/** One human line summarizing a vendor day for the 06:00 digest, or null when
 *  the record is missing/empty. Pure; kWh with one decimal; annotates a
 *  partial PV basis with the dark core's implied production. */
export function vendorDigestLine(rec: VendorDayRecord | undefined | null, todayYmd?: string): string | null {
  if (!rec) return null;
  const k = (wh: number | null | undefined) => (wh == null ? '—' : (wh / 1000).toFixed(1));
  if (rec.homeWh == null && rec.solarWh == null && rec.gridWh == null) return null;
  const dark = rec.impliedDarkPvWh != null ? `; dark-core PV ≈ ${k(rec.impliedDarkPvWh)} kWh` : '';
  const drift = rec.driftHomePct != null ? ` (home drift ${rec.driftHomePct > 0 ? '+' : ''}${rec.driftHomePct}%)` : '';
  // v1.100.0 — name the day instead of asserting "Yesterday". The digest fires at
  // NOTIFY_DIGEST_HOUR (06:00 local) but the vendor ledger job is gated to
  // 06:35-09:00 Phoenix — deliberately AFTER the digest, so yesterday's record
  // does not exist yet when the digest is assembled. Keyed to `prevYmd(today)`
  // the lookup therefore missed every single morning and the line silently never
  // rendered. It now reports the MOST RECENT stored day and says which one, so it
  // always carries real numbers and never mislabels them.
  const label = todayYmd != null && rec.day === prevYmd(todayYmd)
    ? 'Yesterday per the EcoFlow ledger:'
    : `Per the EcoFlow ledger (${rec.day}):`;
  return `${label} home ${k(rec.homeWh)} kWh${drift}, solar ${k(rec.solarWh)}, grid ${k(rec.gridWh)}, battery out ${k(rec.batteryOutWh)} / grid-charge ${k(rec.batteryInWh)}${dark}.`;
}

/**
 * v1.100.0 — the newest stored ledger day that actually carries numbers.
 * Pure; exported for tests.
 */
export function latestVendorDay(state: VendorEnergyState | null | undefined): VendorDayRecord | null {
  const days = state?.days;
  if (!days) return null;
  let best: VendorDayRecord | null = null;
  for (const rec of Object.values(days)) {
    if (!rec || (rec.homeWh == null && rec.solarWh == null && rec.gridWh == null)) continue;
    if (best === null || rec.day > best.day) best = rec;
  }
  return best;
}

/* ─── persistence sidecar (the actuator pattern; capped, atomic) ──────────── */

const SIDECAR = () =>
  process.env.VENDOR_ENERGY_STATE_PATH
    ?? resolve(process.cwd(), config.dbPath, '..', 'vendor-energy-daily.json');
const KEEP_DAYS = 120;

export interface VendorEnergyState {
  lastRunDay: string | null;
  days: Record<string, VendorDayRecord>;
}

export function loadVendorEnergyState(): VendorEnergyState {
  try {
    if (!existsSync(SIDECAR())) return { lastRunDay: null, days: {} };
    const raw = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    if (raw == null || typeof raw !== 'object') return { lastRunDay: null, days: {} };
    return {
      lastRunDay: typeof raw.lastRunDay === 'string' ? raw.lastRunDay : null,
      days: raw.days != null && typeof raw.days === 'object' ? raw.days : {},
    };
  } catch {
    return { lastRunDay: null, days: {} }; // unreadable = start fresh; refetch is cheap
  }
}

export function saveVendorEnergyState(state: VendorEnergyState): void {
  const keys = Object.keys(state.days).sort();
  while (keys.length > KEEP_DAYS) {
    const oldest = keys.shift()!;
    delete state.days[oldest];
  }
  atomicWriteFileSync(SIDECAR(), JSON.stringify(state));
}

/* ─── v1.85.0: backfill day selection (pure) ──────────────────────────────── */

/** Previous Phoenix day of a YYYY-MM-DD string — pure date arithmetic, no
 *  Intl, DST-free (Phoenix). */
export function prevYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  const p = new Date(t);
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}-${String(p.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The days a backfill run should fetch: walking backward from YESTERDAY,
 * skipping days already stored, to at most `horizonDays` back, returning at
 * most `cap` days per run (oldest last — recent history first).
 */
export function missingDays(
  stored: ReadonlySet<string>,
  todayYmd: string,
  horizonDays: number,
  cap: number,
  /** v1.86.0 — days stored but INCOMPLETE (a flagship field null, e.g.
   *  2026-08-06's homeWh) are retried too; day-presence keying alone froze
   *  every fetch-time null forever. */
  incomplete: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  let day = prevYmd(todayYmd);
  for (let back = 0; back < horizonDays && out.length < cap; back++) {
    if (!stored.has(day) || incomplete.has(day)) out.push(day);
    day = prevYmd(day);
  }
  return out;
}

/** v1.86.0 — a record is incomplete when any flagship total is null. */
export function isIncompleteDay(r: VendorDayRecord): boolean {
  return r.homeWh == null || r.solarWh == null || r.gridWh == null
    || r.batteryInWh == null || r.batteryOutWh == null;
}

/* ─── v1.85.0: empirical round-trip efficiency (ADVISORY — never wired into
 * buy sizing until the vendor's battery-in semantics have a proven baseline;
 * the first live day read batteryIn=0 on a sunny day, so their "in" may be
 * grid-only. The report states its basis honestly.) ──────────────────────── */

export interface EmpiricalRte {
  sampleDays: number;
  totalInWh: number;
  totalOutWh: number;
  /** out/in over qualifying days; null until >= MIN_RTE_SAMPLE_DAYS qualify. */
  rte: number | null;
  /** v1.85.1 — what the ratio actually MEANS. The first 25-day backfill read
   *  out/in = 2.41: physically impossible for a round trip, and the day shape
   *  proves it (batteryIn ~= 0 on grid-free days, tracks grid on buy nights) —
   *  the vendor's "battery in" counts GRID-SOURCED charging only, excluding
   *  solar. A ratio near or above ~1.05 is therefore reported as the
   *  grid-only interpretation, not as an efficiency. */
  interpretation: 'rte' | 'vendor-in-is-grid-only' | 'insufficient-data';
}

export const MIN_RTE_SAMPLE_DAYS = 5;
/** A day qualifies only when the vendor recorded a meaningful charge. */
export const RTE_MIN_DAY_IN_WH = 1_000;

export function computeEmpiricalRte(days: ReadonlyArray<VendorDayRecord>): EmpiricalRte {
  let totalInWh = 0;
  let totalOutWh = 0;
  let sampleDays = 0;
  for (const d of days) {
    if (d.batteryInWh == null || d.batteryOutWh == null) continue;
    if (d.batteryInWh < RTE_MIN_DAY_IN_WH) continue;
    sampleDays++;
    totalInWh += d.batteryInWh;
    totalOutWh += d.batteryOutWh;
  }
  const rte = sampleDays >= MIN_RTE_SAMPLE_DAYS && totalInWh > 0
    ? Math.round((totalOutWh / totalInWh) * 1000) / 1000
    : null;
  return {
    sampleDays, totalInWh, totalOutWh, rte,
    interpretation: rte == null ? 'insufficient-data' : rte > 1.05 ? 'vendor-in-is-grid-only' : 'rte',
  };
}

/* ─── the fetch batch ─────────────────────────────────────────────────────── */

const INTER_REQUEST_MS = 400; // gentleness; the whole batch is once daily

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one Phoenix day's vendor energy record for the SHP2. ~19 sequential
 * requests. Any individual failure leaves that field null and continues — a
 * partial record beats none, and nulls are visible in the API response.
 */
export async function fetchVendorDay(
  sn: string,
  ymd: string,
  log: (m: string) => void,
  circuitCount = 12,
): Promise<Omit<VendorDayRecord, 'local' | 'driftHomePct' | 'driftSolarPct'>> {
  const win = dayWindow(ymd);
  const out: Omit<VendorDayRecord, 'local' | 'driftHomePct' | 'driftSolarPct'> = {
    day: ymd, fetchedAtMs: Date.now(),
    homeWh: null, gridWh: null, solarWh: null, generatorWh: null,
    batteryInWh: null, batteryOutWh: null, circuits: [],
  };
  for (const [field, code] of Object.entries(VENDOR_FLOW_CODES) as Array<[keyof typeof VENDOR_FLOW_CODES, string]>) {
    try {
      const resp = await ecoflow.getQuotaData(sn, { code, ...win });
      (out as any)[field] = parseFlowTotalWh(resp);
    } catch (e: any) {
      log(`energy-history: ${field} fetch failed for ${ymd} (${e?.message ?? e})`);
    }
    await sleep(INTER_REQUEST_MS);
  }
  try {
    const resp = await ecoflow.getQuotaData(sn, { code: VENDOR_BATTERY_CODE, ...win });
    const dual = parseBatteryDualWh(resp);
    out.batteryInWh = dual.inWh;
    out.batteryOutWh = dual.outWh;
  } catch (e: any) {
    log(`energy-history: battery fetch failed for ${ymd} (${e?.message ?? e})`);
  }
  await sleep(INTER_REQUEST_MS);
  for (let ch = 1; ch <= circuitCount; ch++) {
    try {
      const resp = await ecoflow.getQuotaData(sn, {
        code: VENDOR_CIRCUIT_CODE,
        field1: `energy_hour_grid_ch${ch}`,
        field2: `energy_hour_oil_ch${ch}`,
        field3: `energy_hour_bak_ch${ch}`,
        ...win,
      });
      const row = parseCircuitDayWh(resp, ch);
      if (row) out.circuits.push(row);
    } catch (e: any) {
      log(`energy-history: circuit ${ch} fetch failed for ${ymd} (${e?.message ?? e})`);
    }
    await sleep(INTER_REQUEST_MS);
  }
  return out;
}
