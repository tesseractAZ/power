/**
 * settingsDrift.ts — v1.83.0. The settings-drift watchdog.
 *
 * WHY: the 2026-08-04 on-peak grid buy was a SETTING ("Charge Now") changed in
 * the EcoFlow app, and nothing noticed until the power flow betrayed it hours
 * later. The 2026-08-16 phantom reserve write was a SETTING the cloud claimed
 * to change and did not. Both incidents share one shape: the fleet's
 * configuration surface moved (or failed to move) invisibly. This engine
 * watches that surface — every documented, live-verified settings key on the
 * SHP2 and each DPU — and reports any change with old → new and which device.
 *
 * READ-ONLY. It never writes, never touches the alarm path, and pushes at
 * most one batched [Medium] notification per confirmed change set.
 *
 * DESIGN
 *  - PURE CORE: extraction, diffing, debouncing and classification are pure
 *    functions over injected state — the tick only feeds and dispatches.
 *  - 2-OBSERVATION DEBOUNCE: a changed value must be seen identically on two
 *    consecutive evaluations before it is confirmed. Mid-write transients and
 *    single-poll glitches never announce.
 *  - BOTH-SIDES RULE: a key is only diffable when present in BOTH surfaces. A
 *    device going offline removes its keys; disappearance is availability,
 *    not drift, and must never announce (Core 2 has been offline for weeks).
 *  - OWN-WRITE AWARENESS: the night-charge actuator legitimately moves the
 *    SHP2's backupReserveSoc twice a night. Changes that match the actuator's
 *    current target/restore values while a night is in flight are classified
 *    'own-write' and logged at info — never pushed. Everything else is
 *    'external'.
 *  - SILENT FIRST ADOPTION: with no persisted surface (first boot on this
 *    version) the current surface is adopted without announcing — the initial
 *    state is a baseline, not a change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

export type SettingValue = string | number | boolean;

/* ─── surface extraction ──────────────────────────────────────────────────── */

/** SHP2 settings keys, flat-first with the pd303_mc. fallback (both appear in
 *  live quota/all; flat is fresher on some firmwares). */
const SHP2_KEYS: ReadonlyArray<string> = [
  'ch1ForceCharge', 'ch2ForceCharge', 'ch3ForceCharge',
  'smartBackupMode', 'backupReserveSoc', 'chargeWattPower',
  'foceChargeHight', 'stormIsEnable', 'epsModeInfo',
  'masterCur', 'oilMaxOutputWatt',
];
const SHP2_PREFIXED = 'pd303_mc.';
/** DPU settings keys (hs_yj751_pd_app_set_info_addr.*), doc-verified live. */
const DPU_KEYS: ReadonlyArray<string> = [
  'sysWordMode', 'sysBackupSoc', 'chgC20SetWatts', 'chg5p8SetWatts',
  'chgMaxSoc', 'dsgMinSoc', 'acOftenOpenFlg', 'acOftenOpenMinSoc',
  'energyMamageEnable',
];
const DPU_PREFIX = 'hs_yj751_pd_app_set_info_addr.';

function normalize(v: unknown): SettingValue | undefined {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export interface SurfaceDevice {
  sn: string;
  label: string;
  kind: 'shp2' | 'dpu';
  raw: Record<string, unknown> | undefined;
}

/** Flat map `"<label> · <setting>" -> value`, only keys actually present. */
export function extractSettingsSurface(devices: SurfaceDevice[]): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const d of devices) {
    if (!d.raw) continue;
    if (d.kind === 'shp2') {
      for (const k of SHP2_KEYS) {
        const v = normalize(d.raw[k]) ?? normalize(d.raw[SHP2_PREFIXED + k]);
        if (v !== undefined) out[`${d.label} · ${k}`] = v;
      }
    } else {
      for (const k of DPU_KEYS) {
        const v = normalize(d.raw[DPU_PREFIX + k]);
        if (v !== undefined) out[`${d.label} · ${k}`] = v;
      }
    }
  }
  return out;
}

/* ─── diff + debounce ─────────────────────────────────────────────────────── */

export interface SettingChange {
  key: string;
  from: SettingValue;
  to: SettingValue;
}

/** Both-sides diff — a key missing on either side is availability, not drift. */
export function diffSurfaces(
  prev: Record<string, SettingValue>,
  next: Record<string, SettingValue>,
): SettingChange[] {
  const out: SettingChange[] = [];
  for (const key of Object.keys(next)) {
    if (!(key in prev)) continue;
    if (prev[key] !== next[key]) out.push({ key, from: prev[key], to: next[key] });
  }
  return out;
}

export interface DriftState {
  /** The last CONFIRMED surface — the baseline changes are measured against. */
  confirmed: Record<string, SettingValue> | null;
  /** Changes seen once, awaiting their second consecutive observation. */
  pending: Record<string, { to: SettingValue }>;
}

export function freshDriftState(): DriftState {
  return { confirmed: null, pending: {} };
}

export interface DriftEvaluation {
  /** Changes confirmed this tick (seen identically twice). */
  confirmedChanges: SettingChange[];
  /** True when this tick adopted the first-ever baseline (announce nothing). */
  adoptedBaseline: boolean;
}

/**
 * One evaluation tick. MUTATES `state`. A change enters `pending` on first
 * sight; it confirms only if the NEXT evaluation still shows the same target
 * value; any other value (including reverting) resets it.
 */
export function evaluateDrift(state: DriftState, surface: Record<string, SettingValue>): DriftEvaluation {
  if (state.confirmed == null) {
    state.confirmed = { ...surface };
    state.pending = {};
    return { confirmedChanges: [], adoptedBaseline: true };
  }
  const raw = diffSurfaces(state.confirmed, surface);
  const confirmedChanges: SettingChange[] = [];
  const nextPending: DriftState['pending'] = {};
  for (const c of raw) {
    const p = state.pending[c.key];
    if (p != null && p.to === c.to) {
      confirmedChanges.push(c); // second consecutive identical observation
    } else {
      nextPending[c.key] = { to: c.to }; // first sight (or the target moved again)
    }
  }
  state.pending = nextPending;
  for (const c of confirmedChanges) state.confirmed[c.key] = c.to;
  // Keys that newly appeared refresh the baseline silently (device came back).
  for (const key of Object.keys(surface)) {
    if (!(key in state.confirmed)) state.confirmed[key] = surface[key];
  }
  return { confirmedChanges, adoptedBaseline: false };
}

/* ─── own-write classification ────────────────────────────────────────────── */

export interface ActuatorContext {
  /** The night-charge actuator's live values, null when idle. */
  targetPct: number | null;
  priorReservePct: number | null;
  /** True while a night is in flight (armed/applied/unresolved) or a revert
   *  landed within the last 15 minutes. */
  nightActive: boolean;
  /** v1.115.0 — the value the OWNER just wrote via /api/reserve-floor, or null
   *  when no such write is inside its grace window. The caller applies the
   *  grace (this module stays clock-free). */
  ownerFloorPct?: number | null;
  /** v1.165.0 — true while a night-charge force-charge of ours is on or its OFF
   *  is unverified (plus the caller's grace after it resolves). Its ch{n}ForceCharge
   *  and foceChargeHight movements are not announced. */
  forceChargeActive?: boolean;
  /** v1.187.10 — what this add-on actually COMMANDED during that force-charge
   *  (nightForceCharge.forceChargeCommandsOf). Only a movement to a commanded value is
   *  'own-write'; any other inside the window is 'panel-side'. Absent ⇒ nothing is
   *  known to be ours. */
  forceChargeCommands?: ForceChargeCommands | null;
}

/** v1.187.10 — the force-charge writes this add-on issued for the night. */
export interface ForceChargeCommands {
  /** The slots switched ON (the OFF goes to the same slots); null when no ON was issued. */
  onSlots: number[] | null;
  /** True once the OFF was issued. */
  offIssued: boolean;
  /** The force-charge ceiling values written: the synced backstop, and the panel's own
   *  value once its restore was issued. */
  ceilingPcts: number[];
}

/** v1.187.10 — did this add-on command this force-charge movement? PURE. */
function forceChargeCommanded(c: SettingChange, slot: number | null, cmd: ForceChargeCommands | null | undefined): boolean {
  if (!cmd) return false;
  if (slot == null) return typeof c.to === 'number' && cmd.ceilingPcts.includes(c.to); // foceChargeHight
  if (cmd.onSlots == null || !cmd.onSlots.includes(slot)) return false;
  if (c.to === 'FORCE_CHARGE_ON') return !cmd.offIssued;
  if (c.to === 'FORCE_CHARGE_OFF') return cmd.offIssued;
  return false;
}

/**
 * 'own-write' = the SHP2 reserve moving to exactly the actuator's target or
 * restore value while its night is in flight. Logged, never pushed. Anything
 * else — including a reserve change with NO night active (the phantom-write
 * investigation's other side) — is 'external'.
 * v1.187.10 — 'panel-side' = a force-charge key moving, inside our force-charge, to a
 * value this add-on did not command: the panel's own ceiling stop turning a slot OFF
 * before the software stop (10-02 04:24-04:25, slots 2 and 1, ~4 min before the add-on's
 * OFF), or an operator. Logged as such and not announced, as before; it was logged as
 * "this add-on's night-charge write", which hid that the panel's backstop fired first.
 */
export function classifyChange(c: SettingChange, act: ActuatorContext): 'own-write' | 'panel-side' | 'external' {
  // v1.165.0 — the night force-charge moves ch{n}ForceCharge twice a night and may
  // sync foceChargeHight once. Without this each night would push two false
  // "changed externally" alerts — the class of false push that 2026-09-16 produced
  // for the reserve. Outside a force-charge they stay EXTERNAL: an operator's
  // Charge Now is exactly what this watchdog exists to report.
  const fc = / · (?:ch([123])ForceCharge|foceChargeHight)$/.exec(c.key);
  if (fc) {
    if (act.forceChargeActive !== true) return 'external';
    return forceChargeCommanded(c, fc[1] != null ? Number(fc[1]) : null, act.forceChargeCommands) ? 'own-write' : 'panel-side';
  }
  if (!c.key.endsWith(' · backupReserveSoc')) return 'external';
  // v1.115.0 — the owner's own reserve-floor write echoes back through the
  // settings surface a poll or two later. It is OURS, and it happens with no
  // night in flight, so it must be recognised BEFORE the nightActive gate.
  if (act.ownerFloorPct != null && c.to === act.ownerFloorPct) return 'own-write';
  if (!act.nightActive) return 'external';
  if (c.to === act.targetPct || c.to === act.priorReservePct) return 'own-write';
  return 'external';
}

/* ─── persistence (survives restarts so old values never re-announce) ─────── */

const SIDECAR = () =>
  process.env.SETTINGS_DRIFT_STATE_PATH
    ?? resolve(process.cwd(), config.dbPath, '..', 'settings-surface.json');

export function loadConfirmedSurface(): Record<string, SettingValue> | null {
  try {
    if (!existsSync(SIDECAR())) return null;
    const raw = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = normalize(v);
      if (n !== undefined) out[k] = n;
    }
    return out;
  } catch {
    return null; // unreadable = silent re-adoption, never a spurious announce
  }
}

export function saveConfirmedSurface(surface: Record<string, SettingValue>): void {
  atomicWriteFileSync(SIDECAR(), JSON.stringify(surface));
}

/* ─── message rendering ───────────────────────────────────────────────────── */

export function renderDriftPush(external: SettingChange[]): { title: string; body: string } {
  const n = external.length;
  const title = n === 1
    ? `Setting changed: ${external[0].key}`
    : `${n} settings changed on the EcoFlow fleet`;
  const lines = external.map((c) => `${c.key}: ${String(c.from)} → ${String(c.to)}`);
  return {
    title,
    body:
      `${lines.join('\n')}\n\n`
      + 'Reported by the settings-drift watchdog (v1.83.0): the fleet\'s configuration '
      + 'surface moved outside this add-on. If you made this change, no action is '
      + 'needed — this exists because the 08-04 on-peak grid buy was an app-side '
      + 'setting nothing noticed.',
  };
}
