/**
 * middayShadow.ts — the winter mid-day charge cycle, computed in SHADOW (plan §8 R4). PURE: the
 * clock, the tariff model and the planner are arguments; nothing here reads a file, writes a
 * device, arms a leg, sends a push or speaks.
 *
 * WHAT THE SHADOW IS. On the evening before a winter weekday the cycle chooser (chargeWindows.ts
 * chooseChargeCycle) would put the cost buy in the next day's APS super off-peak window
 * (10:00–15:00) with the overnight window before it as a resilience-only outage BACKUP. Until the
 * mid-day switch the add-on runs the overnight cycle it always has, and computes the mid-day cycle
 * beside it: both legs sized by the same planner (WindowSpec), whether each would arm against the
 * cycle record in place (chargeCycle.armCycle on it, never persisted), and at 09:30 the morning
 * refresh the cost leg would get (refreshLeg). The result is logged ("night-charge[midday-shadow]:"),
 * stored on the evening's ledger row (shadow_* columns), published on the ecoflow_midday_charge_*
 * entities and shown read-only on the charge card, so the mid-day cycle can be judged on real days
 * before it is allowed to write anything.
 *
 * WHAT IT IS NOT. A shadow record never reaches the live cycle: the evening job arms and announces
 * the overnight plan exactly as before, the actuator ticks at 10:00 and 15:00 find nothing of it,
 * the night-charge entities keep the overnight plan, and `midday_charge_recommended` stays off
 * (middayChargeStateFields: no shadow leg is ever recommended). index.ts hands the orchestration
 * below a planner that sets no holder and persists no snapshot, and an arm probe that returns
 * verdicts only — the types here have no device, push or speech path to call.
 *
 * SIZING (plan §3.3). The backup leg is sized first, on option A: its walk runs from its close to the
 * next overnight open (the backup alone carries the house to 23:00 if the mid-day charge never
 * happens), and it arms when that walk dips under reserve + cushion (nightChargeAdvisor: the backup's
 * arm test and setpoint are one walk). The cost leg is then sized from the pool the backup protects
 * (WindowSpec.backupHold, only when the backup would arm), with its ceiling under the Cores' charge
 * taper (curtailFromPct) and its PV surplus over [close, on-peak).
 */
import {
  chooseChargeCycle, nextChargeableOpenMs, nextOnPeakStartMs, onPeakEndMs, OVERNIGHT_CYCLE,
  type ChargeCycleConfig, type ChargeCycleWhy, type ChargeLeg, type ChargeLegRole, type ChargeWindowKind,
} from './chargeWindows.js';
import { saturationThresholdPct, meanChargeCeilingPct, surplusSpanEndMs } from './chargeTaper.js';
import {
  chargeIsWindowBound, chargeLevelPct, statedBuyKwh, type NightChargePlan, type WindowSpec, type MiddayReserveBasis,
} from './nightChargeAdvisor.js';
import { APPLY_LEAD_MS, clampReserveTarget, MAX_SPOKEN_ADVISORY_CHARS, revertDueMs, type NightChargeMode } from './nightChargeActuator.js';
import { eveningAnnouncement } from './chargeAnnounce.js';
import { buildMiddayRefreshMessage, type MiddayAnnounceInput } from './chargeText.js';
import type { NotifyMessage } from './notify.js';
import { rateAt, type TariffModel } from './tariff.js';
import type { NightLedgerRow } from './recorder.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Every shadow log line starts with this tag. */
export const MIDDAY_SHADOW_LOG_TAG = 'night-charge[midday-shadow]:';
/** The file version of a persisted shadow record. */
export const MIDDAY_SHADOW_VERSION = 1;
/** A shadow record is served (entities, card) at most this long after it was computed: the
 *  entities' own expiry (25 h). */
export const MIDDAY_SHADOW_FRESH_MS = 25 * HOUR_MS;
/** The morning refresh runs from this long before the cost window opens… */
export const REFRESH_LEAD_MS = 30 * MINUTE_MS;
/** …until this long before it; at that point the evening plan stands (plan §3.4). */
export const REFRESH_DEADLINE_MS = 5 * MINUTE_MS;
/** A refresh that moves the expected draw by more than this share of the announced figure would
 *  push (plan §3.4 step 5). */
export const REFRESH_PUSH_MOVE_FRAC = 0.25;

/** The configuration the shadow asks the chooser with: the mid-day window, and the objective and
 *  cost ceiling the add-on is configured with — the cycle the mid-day switch would choose. */
export function shadowCycleConfig(objective: 'cost' | 'resilience', costMaxSocPct: number): ChargeCycleConfig {
  return { costWindow: 'super_off_peak', objective, costMaxSocPct };
}

/* ── sizing one leg ───────────────────────────────────────────────────────── */

/** How one shadow leg is sized: its WindowSpec (window pinned), the planner's horizon end, and the
 *  end of the span of PV surplus its cost ceiling leaves room for. */
export interface ShadowLegSizing {
  spec: WindowSpec;
  nextRechargeMs: number | null;
  surplusEndMs: number;
  /** v1.192.0 — the rate the next charge buys at, ¢/kWh (the cycle's cost window): what the energy a
   *  held reserve keeps in the pool is worth (heldImportEstimate). null/absent: not priced. */
  replaceCentsPerKwh?: number | null;
}

/** The backup leg: resilience-only on its overnight window. Option A (the default): its walk runs to
 *  the next overnight open after its close (the overnight scan). Option B: to `horizonEndMs`, the
 *  cost window's open (v1.192.0 — sized beside A for comparison only, never armed). PURE. */
export function backupLegSizing(model: TariffModel, backup: ChargeLeg, horizonEndMs?: number): ShadowLegSizing {
  return {
    spec: { kind: backup.kind, role: 'backup', window: { startMs: backup.startMs, endMs: backup.endMs } },
    nextRechargeMs: horizonEndMs ?? nextChargeableOpenMs(model, backup.endMs + HOUR_MS, OVERNIGHT_CYCLE),
    surplusEndMs: surplusSpanEndMs(backup.kind, backup.endMs, null),
  };
}

/** The rate the cycle's next charge buys at (its cost window's open), ¢/kWh; null when the rates are
 *  not confirmed. PURE. */
export function replaceCentsPerKwh(model: TariffModel, cost: ChargeLeg): number | null {
  const c = rateAt(model, cost.startMs).centsPerKwh;
  return c != null && Number.isFinite(c) && c >= 0 ? c : null;
}

/** The mid-day cost leg: its window, the taper line of the Cores' mean charge ceiling, the hold an
 *  armed backup gives it, its walk to the next chargeable open (23:00 the same day) and its PV
 *  surplus span (the close to the on-peak start). PURE. */
export function costLegSizing(
  model: TariffModel,
  cost: ChargeLeg,
  cfg: ChargeCycleConfig,
  o: { chgMaxSocPcts: ReadonlyArray<number | null | undefined>; backupHold: { pct: number; untilMs: number } | null; packAcceptKw?: number | null },
): ShadowLegSizing {
  return {
    spec: {
      kind: cost.kind, role: 'cost', window: { startMs: cost.startMs, endMs: cost.endMs },
      curtailFromPct: saturationThresholdPct(meanChargeCeilingPct(o.chgMaxSocPcts)),
      backupHold: o.backupHold,
      packAcceptKw: o.packAcceptKw ?? null,
    },
    nextRechargeMs: nextChargeableOpenMs(model, cost.endMs + HOUR_MS, cfg),
    surplusEndMs: surplusSpanEndMs(cost.kind, cost.endMs, nextOnPeakStartMs(model, cost.endMs)),
  };
}

/** The P50 PV and the median house load the band expects over a window, kWh: the forecast the
 *  shadow's ledger columns grade. Both null unless every hour of the window has a band hour with
 *  both figures — a partial sum is not a forecast of the window. PURE. */
export function windowP50Kwh(
  hours: ReadonlyArray<{ ts: number; pvP50W?: number | null; loadP50W?: number | null }>,
  window: { startMs: number; endMs: number },
): { windowPvP50Kwh: number | null; windowLoadP50Kwh: number | null } {
  const need = Math.round((window.endMs - window.startMs) / HOUR_MS);
  const seen = new Set<number>();
  let pv = 0;
  let load = 0;
  for (const h of hours) {
    if (h.ts < window.startMs || h.ts >= window.endMs) continue;
    if (h.pvP50W == null || !Number.isFinite(h.pvP50W) || h.loadP50W == null || !Number.isFinite(h.loadP50W)) continue;
    const he = Math.floor(h.ts / HOUR_MS);
    if (seen.has(he)) continue;
    seen.add(he);
    pv += Math.max(0, h.pvP50W) / 1000;
    load += Math.max(0, h.loadP50W) / 1000;
  }
  if (need <= 0 || seen.size < need) return { windowPvP50Kwh: null, windowLoadP50Kwh: null };
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  return { windowPvP50Kwh: r2(pv), windowLoadP50Kwh: r2(load) };
}

/* ── what a held reserve sends to the grid (v1.192.0) ─────────────────────── */

/**
 * The house energy a leg's raised reserve sends to the grid while it is held, and what that does to
 * the bill. The SHP2 does not discharge the pool below its backup reserve, so from the write (the
 * window open) to the restore (revertDueMs) a load the pool would have carried down to the owner's
 * reserve is drawn from the grid instead, at that hour's rate. The pool keeps that energy, so the next
 * charge buys less of it — at the cycle's cost window rate, over the charge leg's efficiency.
 *
 * On the overnight-only cycle both happen in the same cheap window and the hold costs almost nothing.
 * On the mid-day cycle the backup's hold (option A, written 50) puts house load on the 12.59¢
 * overnight rate that the 8.2¢ mid-day charge would otherwise have bought back: the figure the
 * backup-horizon decision (A or B) is made on.
 */
export interface HeldImport {
  /** The hold: the write to the restore. */
  fromMs: number;
  untilMs: number;
  /** House energy drawn from the grid because the reserve is held, kWh (AC, median load and PV).
   *  The lift to the reserve — the leg's own draw — is not in it. */
  kwh: number;
  /** That energy at the hours' rates, $. null when a rate is not known (rates not confirmed). */
  importUsd: number | null;
  /** The next charge's saving on what the pool kept of it (the energy a full pool would spill is
   *  not kept), $. null when the cost window's rate is not known. */
  creditUsd: number | null;
  /** importUsd − creditUsd: what the hold adds to the bill, $ (negative: it saves). */
  netUsd: number | null;
}

/** The hold a leg's write makes: from the open (APPLY_LEAD_MS before it) to the restore. PURE. */
export function heldSpan(window: { startMs: number; endMs: number }, nextOnPeakStartMs: number | null): { fromMs: number; untilMs: number } {
  return {
    fromMs: window.startMs - APPLY_LEAD_MS,
    untilMs: revertDueMs({ windowEndMs: window.endMs, nextOnPeakStartMs }) ?? window.endMs,
  };
}

/**
 * heldImportEstimate — two pools walked hour by hour over the hold on the median forecast, as the
 * planner's grid-present carry walks them (nightChargeAdvisor expectedCarryKwh: PV into the pack,
 * load out of it over the discharge efficiency, clamped to [floor, full]): one held at the written
 * reserve (lifted to it at the open, the grid being present), one at the owner's reserve. In each hour
 * the part of the load a pool's floor turns away is drawn from the grid; the held pool's extra, beyond
 * the lift, is the held import. null when the hold, the start or an hour of the band is missing (a
 * partial sum is not an estimate). PURE.
 */
export function heldImportEstimate(o: {
  hours: ReadonlyArray<{ ts: number; pvP50W?: number | null; loadP50W?: number | null }>;
  fromMs: number;
  untilMs: number;
  /** The pool expected at the open (NightChargePlan.expectedStartSocPct). */
  startSocPct: number | null;
  /** The reserve the write holds; null: no write, no hold. */
  holdPct: number | null;
  /** The owner's reserve (the restore target). */
  floorPct: number;
  fullKwh: number;
  dischargeEff: number;
  legEff: number;
  centsAt: (ms: number) => number | null;
  replaceCentsPerKwh: number | null;
}): HeldImport | null {
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  if (!ok(o.startSocPct) || !ok(o.holdPct) || !ok(o.floorPct) || !(o.fullKwh > 0) || !(o.untilMs > o.fromMs)) return null;
  if (!(o.dischargeEff > 0 && o.dischargeEff <= 1) || !(o.legEff > 0 && o.legEff <= 1)) return null;
  const full = o.fullKwh;
  const kwhOf = (pct: number): number => (full * Math.max(0, Math.min(100, pct))) / 100;
  let free = kwhOf(o.startSocPct);
  let held = free;
  // As the carry: a pool already under the owner's reserve is not drained further.
  const freeFloor = Math.min(kwhOf(o.floorPct), free);
  const holdFloor = Math.max(freeFloor, kwhOf(o.holdPct));
  const byHour = new Map<number, { pvP50W?: number | null; loadP50W?: number | null }>();
  for (const h of o.hours) byHour.set(Math.floor(h.ts / HOUR_MS), h);
  /** One hour of one pool: the energy its floor turns away (pack kWh), split into the lift to the
   *  floor and the load the grid carries; the pool after it. */
  const step = (pack: number, floor: number, net: number): { pack: number; lift: number; load: number } => {
    const u = pack + net;
    const top = Math.max(0, floor - u);
    const load = Math.max(0, top - Math.max(0, floor - pack));
    return { pack: Math.min(full, Math.max(floor, u)), lift: top - load, load };
  };
  let extraPack = 0;
  let liftPack = 0;
  let importCents = 0;
  let priced = true;
  for (let slot = Math.floor(o.fromMs / HOUR_MS) * HOUR_MS; slot < o.untilMs; slot += HOUR_MS) {
    const w = (Math.min(o.untilMs, slot + HOUR_MS) - Math.max(o.fromMs, slot)) / HOUR_MS;
    if (w <= 0) continue;
    const h = byHour.get(slot / HOUR_MS);
    if (h == null || !ok(h.pvP50W) || !ok(h.loadP50W)) return null;
    const net = (w * (Math.max(0, h.pvP50W) - Math.max(0, h.loadP50W) / o.dischargeEff)) / 1000;
    const f = step(free, freeFloor, net);
    const k = step(held, holdFloor, net);
    free = f.pack;
    held = k.pack;
    liftPack += k.lift;
    const extra = k.load - f.load;
    extraPack += extra;
    const cents = o.centsAt(Math.max(o.fromMs, slot));
    if (ok(cents)) importCents += extra * o.dischargeEff * cents;
    else if (extra !== 0) priced = false;
  }
  // What the pool kept of it: the held pool's surplus at the restore beyond its lift (a full pool
  // spills PV the free one stores, and that part is not kept).
  const keptPack = Math.max(0, Math.min(Math.max(0, extraPack), held - free - liftPack));
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const importUsd = priced ? r2(importCents / 100) : null;
  const creditUsd = ok(o.replaceCentsPerKwh) ? r2(((keptPack / o.legEff) * o.replaceCentsPerKwh) / 100) : null;
  return {
    fromMs: o.fromMs, untilMs: o.untilMs,
    kwh: r2(extraPack * o.dischargeEff),
    importUsd, creditUsd,
    netUsd: importUsd != null && creditUsd != null ? r2(importUsd - creditUsd) : null,
  };
}

/* ── the record ───────────────────────────────────────────────────────────── */

/** One leg as the shadow sized it. Figures as the planner gave them; null where it gave none. */
export interface ShadowLegSummary {
  role: ChargeLegRole;
  kind: ChargeWindowKind;
  windowStartMs: number;
  windowEndMs: number;
  basisComplete: boolean;
  /** The plan calls for a charge (its worst case reaches ARB_MIN_BUY_KWH). */
  chargeTonight: boolean;
  /** The reserve the leg would write (clampReserveTarget of the setpoint): T_mid on the cost leg. */
  reservePct: number | null;
  /** Which term of T_mid set it (the cost leg only). */
  reserveBasis: MiddayReserveBasis | null;
  /** The level the write would drive the pool to (chargeLevelPct). */
  levelPct: number | null;
  /** C_mid on the cost leg (the cost ceiling under the taper). */
  costCeilingSocPct: number | null;
  /** The worst case the leg is sized on, and the draw it is expected to make. */
  buyKwh: number | null;
  expectedBuyKwh: number | null;
  /** The pool expected at the window open. */
  expectedStartSocPct: number | null;
  /** The trough its walk graded, and the line. */
  cushionTroughSocPct: number | null;
  cushionLineSocPct: number | null;
  /** Whether it would arm against the cycle in place (never armed), and why not. */
  wouldArm: boolean;
  disposition: string;
  /** The P50 PV and load the plan expects over the window, kWh (the cost leg). */
  windowPvP50Kwh: number | null;
  windowLoadP50Kwh: number | null;
  /** R5 — the window closes before the level is reached (chargeIsWindowBound), and the leg cannot
   *  hold the cushion: what the evening's words say of it. Absent on a record from before R5. */
  toward?: boolean;
  cushionShortfall?: boolean;
  /** v1.192.0 — the house energy its hold sends to the grid, and the bill effect (heldImportEstimate);
   *  null when it writes nothing or the band does not cover the hold. Absent on an older record. */
  heldImport?: HeldImport | null;
}

/** What the morning refresh decided (refreshLeg). */
export type RefreshDisposition = 'unchanged' | 'lowered' | 'capped' | 'cancelled' | 'stood';
/** What the SHADOW refresh recorded: refreshLeg's decision, or that it was not made —
 *  'not-comparable' when the live overnight leg of the same evening wrote to the panel
 *  (liveOvernightWrote): the pool it would size on is not the one a mid-day cycle would have had. */
export type ShadowRefreshDisposition = RefreshDisposition | 'not-comparable';

export interface ShadowRefresh {
  atMs: number;
  disposition: ShadowRefreshDisposition;
  /** What the leg would run on after the refresh (the announced figures when it stood). */
  levelPct: number | null;
  reservePct: number | null;
  buyKwh: number | null;
  expectedBuyKwh: number | null;
  /** A live refresh would push (plan §3.4 step 5). The shadow never sends it. */
  wouldPush: boolean;
  reason: string;
  /** R5 — how old the weather the refresh was sized on was, seconds (null: unknown). The shadow
   *  asks the worker for no particular age (the plumbing is inert until the switch); a live refresh
   *  asks for weather at most REFRESH_MAX_WEATHER_AGE_MS old and defers on older. */
  weatherAgeS?: number | null;
  /** R5 — the level the re-plan asked for (above the announced one when capped), and the window's
   *  P50 PV it was sized on, kWh: what the refresh push says of a cap and a moved figure. */
  neededLevelPct?: number | null;
  windowPvP50Kwh?: number | null;
  /** The reserve the re-plan asked for (above the announced one when that capped it): what the
   *  refresh push says of a reserve cap. */
  neededReservePct?: number | null;
}

export interface MiddayShadowRecord {
  version: number;
  /** The plan date the cycle belongs to (the evening that computed it). */
  day: string;
  computedAtMs: number;
  why: ChargeCycleWhy;
  /** The configured write mode: what the switch would do in it (advisory arms nothing). */
  mode: NightChargeMode;
  backup: ShadowLegSummary | null;
  /** v1.192.0 — the backup sized on option B (its walk to the cost window's open), beside option A,
   *  for the backup-horizon decision: never armed, never anchors the cost leg. Absent on an older
   *  record; null when there is no backup or the planner gave none. */
  backupB?: ShadowLegSummary | null;
  cost: ShadowLegSummary | null;
  refresh: ShadowRefresh | null;
  /** Why the legs were not sized, when they were not. */
  note: string | null;
}

/** A sized leg, as index.ts returns it: the plan and the P50 PV / load over its window. */
export interface ShadowSized {
  plan: NightChargePlan;
  windowPvP50Kwh: number | null;
  windowLoadP50Kwh: number | null;
  /** R5 — when the weather the plan's forecast was built on was fetched (the band's
   *  weatherFetchedAtMs); null/absent when unknown. */
  weatherFetchedAtMs?: number | null;
  /** v1.192.0 — heldImportEstimate over the leg's hold (index.ts, on the band it was planned on). */
  heldImport?: HeldImport | null;
}

/** The arm probe's answer: the roles armCycle armed, and the ones it refused with its words. */
export interface ShadowArmVerdict {
  armed: ChargeLegRole[];
  refused: Array<{ role: ChargeLegRole; reason: string }>;
}

/** One leg handed to the arm probe. */
export interface ShadowArmCandidate {
  role: ChargeLegRole;
  kind: ChargeWindowKind;
  plan: NightChargePlan;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A sized leg summarised. PURE. */
export function summariseLeg(
  leg: ChargeLeg,
  sized: ShadowSized | null,
  arm: { wouldArm: boolean; disposition: string },
): ShadowLegSummary {
  const p = sized?.plan ?? null;
  return {
    role: leg.role, kind: leg.kind, windowStartMs: leg.startMs, windowEndMs: leg.endMs,
    basisComplete: p?.basisComplete === true,
    chargeTonight: p?.chargeTonight === true,
    reservePct: p?.setpointSocPct != null && Number.isFinite(p.setpointSocPct) ? clampReserveTarget(p.setpointSocPct) : null,
    reserveBasis: p?.reserveTargetBasis ?? null,
    levelPct: p != null ? fin(chargeLevelPct(p)) : null,
    costCeilingSocPct: fin(p?.costCeilingSocPct),
    buyKwh: fin(p?.buyKwh),
    expectedBuyKwh: p != null ? statedBuyKwh(p) : null,
    expectedStartSocPct: fin(p?.expectedStartSocPct),
    cushionTroughSocPct: fin(p?.cushionTroughSocPct),
    cushionLineSocPct: fin(p?.cushionLineSocPct),
    wouldArm: arm.wouldArm,
    disposition: arm.disposition,
    windowPvP50Kwh: fin(sized?.windowPvP50Kwh),
    windowLoadP50Kwh: fin(sized?.windowLoadP50Kwh),
    ...(p != null ? { toward: chargeIsWindowBound(p) === true, cushionShortfall: p.cushionShortfall === true } : {}),
    heldImport: sized?.heldImport ?? null,
  };
}

/* ── the evening ──────────────────────────────────────────────────────────── */

/** Option B's disposition: it is a comparison, never a leg. */
export const OPTION_B_DISPOSITION = 'option B (walk to the mid-day open), for comparison: never armed';

/** What the evening shadow is handed. No device, push or speech path: a leg is sized, and the
 *  legs are probed against the cycle in place, and that is all it can do. */
export interface MiddayShadowEveningDeps {
  nowMs: number;
  day: string;
  model: TariffModel;
  cfg: ChargeCycleConfig;
  mode: NightChargeMode;
  chgMaxSocPcts: ReadonlyArray<number | null | undefined>;
  /** index.ts recomputeNightChargePlan with a shadow leg: no plan holder, no snapshot, no ledger. */
  sizeLeg: (s: ShadowLegSizing) => Promise<ShadowSized | null | 'panelStale'>;
  /** chargeCycle.armCycle against the cycle in place; the result is never persisted. */
  armProbe: (cands: ShadowArmCandidate[]) => ShadowArmVerdict;
}

/** Why a leg that charges would not arm, in the probe's words; the arm verdict for the record. */
function armVerdictFor(
  role: ChargeLegRole, plan: NightChargePlan | null, mode: NightChargeMode, verdict: ShadowArmVerdict | null,
): { wouldArm: boolean; disposition: string } {
  if (plan == null) return { wouldArm: false, disposition: 'not sized — the planner had no inputs' };
  if (!plan.basisComplete) return { wouldArm: false, disposition: `not armed — the plan basis is incomplete${plan.basisBlockedBy ? ` (${plan.basisBlockedBy})` : ''}` };
  if (!plan.chargeTonight) {
    const re = plan.middayReentryHold;
    return {
      wouldArm: false,
      disposition: re != null
        ? `not armed — the plan holds: the charge would take the pool only to ~${re.arrivalPct}%, under the ${re.linePct}% re-entry line`
        : 'not armed — the plan holds (no buy needed)',
    };
  }
  if (mode === 'advisory') return { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' };
  if (verdict?.armed.includes(role)) return { wouldArm: true, disposition: 'would arm' };
  const why = verdict?.refused.find((r) => r.role === role)?.reason;
  return { wouldArm: false, disposition: `would not arm — ${why ?? 'the arm probe refused it'}` };
}

/**
 * The evening's shadow (plan §3.2 at 21:30, without the arm). PURE apart from the injected planner.
 *  1. The chooser: a cycle that is not mid-day ('no-run-in-scan' on Friday and Saturday, the season
 *     grace, a configuration that does not ask for a mid-day buy) is recorded with its reason and
 *     nothing is sized.
 *  2. The backup leg on option A, and whether it would arm alone.
 *  3. The cost leg from the pool the backup protects (its hold only when the backup would arm).
 *  4. Both legs probed together: what armCycle would arm.
 * 'panelStale' when the planner asks for a retry (the evening job's own deferral).
 */
export async function runMiddayShadowEvening(d: MiddayShadowEveningDeps): Promise<MiddayShadowRecord | 'panelStale'> {
  const cycle = chooseChargeCycle(d.model, d.nowMs, d.cfg);
  const base: MiddayShadowRecord = {
    version: MIDDAY_SHADOW_VERSION, day: d.day, computedAtMs: d.nowMs, why: cycle.why, mode: d.mode,
    backup: null, cost: null, refresh: null, note: null,
  };
  if (cycle.why !== 'midday' || cycle.cost == null) return base;

  // What the energy a held reserve keeps is worth: the cycle's next charge buys it at the cost window.
  const replace = replaceCentsPerKwh(d.model, cycle.cost);
  let backupSized: ShadowSized | null = null;
  let backupArm: { wouldArm: boolean; disposition: string } | null = null;
  if (cycle.backup != null) {
    const b = await d.sizeLeg({ ...backupLegSizing(d.model, cycle.backup), replaceCentsPerKwh: replace });
    if (b === 'panelStale') return 'panelStale';
    backupSized = b;
    const p = b?.plan ?? null;
    const probe = p != null && p.basisComplete && p.chargeTonight && d.mode !== 'advisory'
      ? d.armProbe([{ role: 'backup', kind: cycle.backup.kind, plan: p }]) : null;
    backupArm = armVerdictFor('backup', p, d.mode, probe);
  }
  const holdPct = backupArm?.wouldArm && backupSized?.plan.setpointSocPct != null
    ? clampReserveTarget(backupSized.plan.setpointSocPct) : null;
  const backupHold = holdPct != null && cycle.backup != null ? { pct: holdPct, untilMs: cycle.backup.endMs } : null;

  const c = await d.sizeLeg({ ...costLegSizing(d.model, cycle.cost, d.cfg, { chgMaxSocPcts: d.chgMaxSocPcts, backupHold }), replaceCentsPerKwh: replace });
  if (c === 'panelStale') return 'panelStale';
  const cp = c?.plan ?? null;

  // v1.192.0 — option B beside A, for the backup-horizon decision: the same backup window, its walk to
  // the cost window's open. Sized last, never probed or armed, and it anchors nothing; a planner that
  // has nothing for it leaves it null rather than deferring the evening.
  let backupB: ShadowLegSummary | null = null;
  if (cycle.backup != null) {
    const bb = await d.sizeLeg({ ...backupLegSizing(d.model, cycle.backup, cycle.cost.startMs), replaceCentsPerKwh: replace });
    if (bb !== 'panelStale' && bb != null) backupB = summariseLeg(cycle.backup, bb, { wouldArm: false, disposition: OPTION_B_DISPOSITION });
  }

  // Both legs together, as the evening job would arm them (the backup first).
  const cands: ShadowArmCandidate[] = [];
  if (backupArm?.wouldArm && backupSized != null && cycle.backup != null) cands.push({ role: 'backup', kind: cycle.backup.kind, plan: backupSized.plan });
  if (cp != null && cp.basisComplete && cp.chargeTonight) cands.push({ role: 'cost', kind: cycle.cost.kind, plan: cp });
  const joint = cands.length > 0 && d.mode !== 'advisory' ? d.armProbe(cands) : null;

  // The backup's final verdict is the joint probe's when it armed alone (it is the joint's first leg,
  // checked against the same record, so the two agree); otherwise its own.
  const backupFinal = backupArm?.wouldArm && joint != null
    ? armVerdictFor('backup', backupSized?.plan ?? null, d.mode, joint) : backupArm;
  const backup = cycle.backup != null && backupFinal != null ? summariseLeg(cycle.backup, backupSized, backupFinal) : null;
  const cost = summariseLeg(cycle.cost, c, armVerdictFor('cost', cp, d.mode, joint));
  return { ...base, backup, backupB, cost };
}

/* ── the morning refresh (plan §3.4, a computation only) ──────────────────── */

/** What the evening announced for the cost leg (the consent ceiling), and what the refresh found. */
export interface RefreshInputs {
  announced: { levelPct: number | null; reservePct: number | null; expectedBuyKwh: number | null; buyKwh: number | null };
  refreshed: {
    basisComplete: boolean; chargeTonight: boolean;
    levelPct: number | null; reservePct: number | null; expectedBuyKwh: number | null; buyKwh: number | null;
    /** The refreshed plan held on the re-entry line (NightChargePlan.middayReentryHold). */
    reentryHold?: { arrivalPct: number; linePct: number } | null;
  } | null;
}

/**
 * refreshLeg — the morning refresh's rule (plan §3.4 step 3), for the shadow and the live refresh
 * alike (morningRefresh.liveRefreshOutcome). PURE. What the evening announced is the consent
 * ceiling of every written value: the 21:30 push named the level and the reserve held from the
 * open, so the refresh may lower or cancel the charge, never raise either.
 *  - no refreshed plan (no inputs, an incomplete basis): the evening plan stands ('stood');
 *  - a hold cancels the leg ('cancelled');
 *  - a refreshed level or reserve above the announced level, or a refreshed reserve above the
 *    announced reserve, is recorded 'capped': nothing is written, every figure stays as announced
 *    (the worst case too: the leg runs on the announced level and reserve), and no expected draw
 *    is stated (it was sized on values that will not be written);
 *  - else the refreshed stop and reserve, at most the announced ones (a figure the re-plan does
 *    not give stays as announced; the reserve never above 50): 'lowered' when the stop or the
 *    reserve came down, 'unchanged' otherwise.
 * `wouldPush` (step 5): a cancel, a changed written value, a cap, or an expected draw that moved by
 * more than REFRESH_PUSH_MOVE_FRAC of the announced one either way.
 */
export function refreshLeg(i: RefreshInputs): Omit<ShadowRefresh, 'atMs' | 'disposition'> & { disposition: RefreshDisposition } {
  const a = i.announced;
  const r = i.refreshed;
  if (r == null || !r.basisComplete) {
    return {
      disposition: 'stood', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: a.expectedBuyKwh,
      wouldPush: false, reason: r == null ? 'the refresh had no plan; the evening plan stands' : 'the refreshed basis is incomplete; the evening plan stands',
    };
  }
  if (!r.chargeTonight) {
    const re = r.reentryHold;
    return {
      disposition: 'cancelled', levelPct: null, reservePct: null, buyKwh: 0, expectedBuyKwh: 0, wouldPush: true,
      reason: re != null
        ? `the refreshed plan holds: the charge would take the pool only to ~${re.arrivalPct}%, under the ${re.linePct}% re-entry line`
        : 'the refreshed plan holds: no charge is needed',
    };
  }
  const ceil = a.levelPct;
  const levelAbove = ceil != null && r.levelPct != null && r.levelPct > ceil + 1e-9;
  // A higher reserve than the one announced is a higher need, as a higher level is.
  const reserveAbove = r.reservePct != null && ((ceil != null && r.reservePct > ceil + 1e-9)
    || (a.reservePct != null && r.reservePct > a.reservePct + 1e-9));
  if (levelAbove || reserveAbove) {
    return {
      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,
      reason: levelAbove
        ? `the refreshed need (${r.levelPct}%) is above the announced ${ceil}%: held at it`
        : `the refreshed reserve (${r.reservePct}%) is above the announced ${a.reservePct ?? ceil}%: held at it`,
    };
  }
  // Below a cap the re-plan is at most what was announced: its figures are the leg's (a figure it
  // does not give stays as announced), the reserve never above the panel's 50.
  const levelPct = r.levelPct ?? a.levelPct;
  const reservePct = r.reservePct != null ? Math.min(50, r.reservePct) : a.reservePct;
  const lowered = (a.levelPct != null && levelPct != null && levelPct < a.levelPct - 1e-9)
    || (a.reservePct != null && reservePct != null && reservePct < a.reservePct - 1e-9);
  const disposition: RefreshDisposition = lowered ? 'lowered' : 'unchanged';
  const expectedBuyKwh = r.expectedBuyKwh;
  const moved = a.expectedBuyKwh != null && a.expectedBuyKwh > 0 && expectedBuyKwh != null
    && Math.abs(expectedBuyKwh - a.expectedBuyKwh) > REFRESH_PUSH_MOVE_FRAC * a.expectedBuyKwh;
  const written = (a.reservePct != null && reservePct != null && reservePct !== a.reservePct)
    || (a.levelPct != null && levelPct != null && levelPct !== a.levelPct);
  const reason = lowered ? `lowered to ~${levelPct ?? '—'}% (announced ${a.levelPct ?? '—'}%)` : 'the evening plan holds as announced';
  return { disposition, levelPct, reservePct, buyKwh: r.buyKwh, expectedBuyKwh, wouldPush: written || moved, reason };
}

/** Whether the shadow refresh is due now: 'run' inside [open − REFRESH_LEAD_MS, open −
 *  REFRESH_DEADLINE_MS) with no refresh yet; 'stand' once that has passed with none (the evening
 *  plan stands), until the window closes; null otherwise — no mid-day leg, a leg that holds, or a
 *  refresh already made. PURE. */
export function shadowRefreshDue(rec: MiddayShadowRecord | null, nowMs: number): 'run' | 'stand' | null {
  const c = rec?.cost;
  if (rec == null || c == null || rec.refresh != null || !c.basisComplete || !c.chargeTonight) return null;
  if (nowMs >= c.windowEndMs) return null;
  if (nowMs >= c.windowStartMs - REFRESH_DEADLINE_MS) return 'stand';
  return nowMs >= c.windowStartMs - REFRESH_LEAD_MS ? 'run' : null;
}

/** The refresh a record gets when its window comes within REFRESH_DEADLINE_MS with none made. PURE. */
export function standingRefresh(rec: MiddayShadowRecord, nowMs: number): ShadowRefresh {
  const c = rec.cost!;
  return {
    atMs: nowMs, disposition: 'stood', levelPct: c.levelPct, reservePct: c.reservePct, buyKwh: c.buyKwh,
    expectedBuyKwh: c.expectedBuyKwh, wouldPush: false,
    reason: `no refresh completed by ${REFRESH_DEADLINE_MS / MINUTE_MS} minutes before the window; the evening plan stands`,
  };
}

/** The refresh from a re-sized cost leg (null: the planner had no inputs). R5: the age of the
 *  weather it was sized on is recorded, with the level it asked for and the window's P50 PV. PURE. */
export function refreshFromSized(rec: MiddayShadowRecord, sized: ShadowSized | null, nowMs: number): ShadowRefresh {
  const c = rec.cost!;
  const p = sized?.plan ?? null;
  const refreshedReserve = p != null && p.setpointSocPct != null && Number.isFinite(p.setpointSocPct) ? clampReserveTarget(p.setpointSocPct) : null;
  const r = refreshLeg({
    announced: { levelPct: c.levelPct, reservePct: c.reservePct, expectedBuyKwh: c.expectedBuyKwh, buyKwh: c.buyKwh },
    refreshed: p == null ? null : {
      basisComplete: p.basisComplete, chargeTonight: p.chargeTonight,
      levelPct: fin(chargeLevelPct(p)),
      reservePct: refreshedReserve,
      expectedBuyKwh: statedBuyKwh(p), buyKwh: fin(p.buyKwh),
      reentryHold: p.middayReentryHold ?? null,
    },
  });
  return {
    atMs: nowMs, ...r,
    weatherAgeS: weatherAgeSeconds(sized?.weatherFetchedAtMs, nowMs),
    neededLevelPct: p != null ? fin(chargeLevelPct(p)) : null,
    windowPvP50Kwh: fin(sized?.windowPvP50Kwh),
    neededReservePct: refreshedReserve,
  };
}

/** The age of the weather a refresh was sized on, whole seconds; null when unknown. PURE. */
export function weatherAgeSeconds(fetchedAtMs: number | null | undefined, nowMs: number): number | null {
  return fetchedAtMs != null && Number.isFinite(fetchedAtMs) ? Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000)) : null;
}

/**
 * The live overnight leg of the shadow's evening wrote to the panel: a reserve raise applied, or a
 * force-charge switched on. PURE. The shadow refresh sizes on the live pool at 09:30 (the backup's
 * hold has closed by then), and in a write mode with the cost objective — the only configuration
 * the shadow sizes in outside advisory — the live overnight cost leg has by then filled the pool
 * toward its own ceiling, often 30 points or more above what a mid-day cycle's 10:00 open would
 * find. A refresh re-sized on that pool reads the cost leg as nearly done or cancelled. It is
 * therefore not made (notComparableRefresh). The evening's own sizing is unaffected: nothing is
 * written before 21:30.
 */
export function liveOvernightWrote(
  rec: Pick<MiddayShadowRecord, 'day'>,
  live: { day: string | null; appliedAtMs: number | null; forceChargeOnAtMs: number | null },
): boolean {
  return live.day != null && live.day === rec.day && (live.appliedAtMs != null || live.forceChargeOnAtMs != null);
}

/** Why a shadow refresh was not made, for the record and the log. */
export const NOT_COMPARABLE_REASON =
  'the live overnight charge wrote to the panel, so the 09:30 pool is not the one a mid-day cycle would have had; '
  + 'not re-sized — the evening plan stands as the shadow\'s figures';

/** The refresh recorded when it cannot be compared (liveOvernightWrote): no re-sized figures, no
 *  push. The surfaces keep the evening's figures. PURE. */
export function notComparableRefresh(nowMs: number): ShadowRefresh {
  return {
    atMs: nowMs, disposition: 'not-comparable',
    levelPct: null, reservePct: null, buyKwh: null, expectedBuyKwh: null,
    wouldPush: false, reason: NOT_COMPARABLE_REASON, weatherAgeS: null, neededLevelPct: null, windowPvP50Kwh: null, neededReservePct: null,
  };
}

/** The refresh's figures are re-sized ones the surfaces show in place of the evening's: not when the
 *  evening plan stood, nor when the refresh could not be compared. PURE. */
export function refreshResized(r: Pick<ShadowRefresh, 'disposition'> | null): boolean {
  return r != null && r.disposition !== 'stood' && r.disposition !== 'not-comparable';
}

/** The cost leg's sizing for its morning refresh: the evening's, with the backup's hold (already
 *  closed at 09:30: the planner sizes on the pool as it is). PURE. */
export function refreshSizing(
  model: TariffModel, rec: MiddayShadowRecord, cfg: ChargeCycleConfig, chgMaxSocPcts: ReadonlyArray<number | null | undefined>,
): ShadowLegSizing | null {
  const c = rec.cost;
  if (c == null) return null;
  const leg: ChargeLeg = { role: 'cost', kind: c.kind, startMs: c.windowStartMs, endMs: c.windowEndMs };
  const b = rec.backup;
  const backupHold = b?.wouldArm && b.reservePct != null ? { pct: b.reservePct, untilMs: b.windowEndMs } : null;
  return costLegSizing(model, leg, cfg, { chgMaxSocPcts, backupHold });
}

/* ── the surfaces ─────────────────────────────────────────────────────────── */

/** The record is the current one: computed within MIDDAY_SHADOW_FRESH_MS, its mid-day window not
 *  yet closed. PURE. */
export function shadowServed(rec: MiddayShadowRecord | null, nowMs: number): boolean {
  return rec != null && rec.cost != null && nowMs - rec.computedAtMs < MIDDAY_SHADOW_FRESH_MS && nowMs < rec.cost.windowEndMs;
}

/** The ISO instant an entity publishes (HA timestamp sensors), or null. */
const iso = (ms: number | null | undefined): string | null => (ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** What the ecoflow_midday_charge_* figures are: 'shadow' — computed, never armed — until the mid-day
 *  switch arms a live mid-day leg ('live'). Published beside them (`midday_charge_basis`) and carried
 *  on each figure entity as its `basis` attribute, so a dashboard, an automation or the recorder's
 *  history can tell a preview from a charge that runs. */
export type MiddayChargeBasis = 'shadow' | 'live';
/** Every mid-day figure this release publishes is a shadow computation. */
export const MIDDAY_CHARGE_BASIS: MiddayChargeBasis = 'shadow';

/**
 * The ecoflow_midday_charge_* fields of the HA state payload (MQTT and /api/ha-state alike). PURE.
 *  - `midday_charge_recommended` is the LIVE mid-day leg's charge decision. Nothing arms a mid-day
 *    leg before the switch, so it is strictly false: a shadow computation is never a recommendation
 *    an automation may act on.
 *  - `midday_charge_basis`: MIDDAY_CHARGE_BASIS, with or without a current record.
 *  - the figures are the mid-day leg as computed — the refreshed figures once the morning refresh
 *    ran (a cancelled refresh nulls them) — null when there is no current record (shadowServed).
 *  - `midday_charge_refresh`: 'pending' before the refresh, then its disposition.
 */
export function middayChargeStateFields(rec: MiddayShadowRecord | null, nowMs: number = Date.now()): {
  midday_charge_recommended: boolean;
  midday_charge_target_soc_percent: number | null;
  midday_charge_reserve_hold_percent: number | null;
  midday_charge_expected_buy_kwh: number | null;
  midday_charge_buy_kwh: number | null;
  midday_charge_window_start_at: string | null;
  midday_charge_window_end_at: string | null;
  midday_charge_refresh: string | null;
  midday_charge_basis: MiddayChargeBasis;
} {
  if (!shadowServed(rec, nowMs)) {
    return {
      midday_charge_recommended: false,
      midday_charge_target_soc_percent: null, midday_charge_reserve_hold_percent: null,
      midday_charge_expected_buy_kwh: null, midday_charge_buy_kwh: null,
      midday_charge_window_start_at: null, midday_charge_window_end_at: null, midday_charge_refresh: null,
      midday_charge_basis: MIDDAY_CHARGE_BASIS,
    };
  }
  const c = rec!.cost!;
  const r = rec!.refresh;
  const charges = c.basisComplete && c.chargeTonight;
  const cancelled = r?.disposition === 'cancelled';
  const pick = <K extends 'levelPct' | 'reservePct' | 'expectedBuyKwh' | 'buyKwh'>(k: K): number | null => {
    if (!c.basisComplete || cancelled) return null;
    return refreshResized(r) ? r![k] : c[k];
  };
  return {
    midday_charge_recommended: false,
    midday_charge_target_soc_percent: charges ? pick('levelPct') : null,
    midday_charge_reserve_hold_percent: charges ? pick('reservePct') : null,
    midday_charge_expected_buy_kwh: pick('expectedBuyKwh'),
    midday_charge_buy_kwh: pick('buyKwh'),
    midday_charge_window_start_at: iso(c.windowStartMs),
    midday_charge_window_end_at: iso(c.windowEndMs),
    midday_charge_refresh: r?.disposition ?? (charges ? 'pending' : null),
    midday_charge_basis: MIDDAY_CHARGE_BASIS,
  };
}

/** The evening's shadow columns of the ledger row (plan columns stay the live overnight plan's). PURE. */
export function middayShadowLedgerColumns(rec: MiddayShadowRecord): Partial<NightLedgerRow> {
  const b = rec.backup;
  const c = rec.cost;
  const bit = (v: boolean | undefined): number | null => (v == null ? null : v ? 1 : 0);
  const disp = [b ? `backup: ${b.disposition}` : null, c ? `cost: ${c.disposition}` : null].filter(Boolean).join('; ');
  return {
    shadow_cycle_why: rec.why,
    shadow_computed_at_ms: rec.computedAtMs,
    shadow_backup_window_start_ms: b?.windowStartMs ?? null,
    shadow_backup_window_end_ms: b?.windowEndMs ?? null,
    shadow_backup_arms: bit(b?.wouldArm),
    shadow_backup_setpoint_pct: b?.reservePct ?? null,
    shadow_backup_buy_kwh: b?.buyKwh ?? null,
    shadow_backup_expected_buy_kwh: b?.expectedBuyKwh ?? null,
    shadow_backup_cushion_trough_soc_pct: b?.cushionTroughSocPct ?? null,
    shadow_backup_cushion_line_soc_pct: b?.cushionLineSocPct ?? null,
    shadow_cost_window_start_ms: c?.windowStartMs ?? null,
    shadow_cost_window_end_ms: c?.windowEndMs ?? null,
    shadow_cost_arms: bit(c?.wouldArm),
    shadow_cost_reserve_pct: c?.reservePct ?? null,
    shadow_cost_reserve_basis: c?.reserveBasis ?? null,
    shadow_cost_level_pct: c?.levelPct ?? null,
    shadow_cost_ceiling_soc_pct: c?.costCeilingSocPct ?? null,
    shadow_cost_buy_kwh: c?.buyKwh ?? null,
    shadow_cost_expected_buy_kwh: c?.expectedBuyKwh ?? null,
    shadow_cost_expected_start_soc_pct: c?.expectedStartSocPct ?? null,
    shadow_arm_disposition: disp.length > 0 ? disp : (rec.note ?? null),
    shadow_window_pv_p50_kwh: c?.windowPvP50Kwh ?? null,
    shadow_window_load_p50_kwh: c?.windowLoadP50Kwh ?? null,
    // v1.192.0 — what each hold sends to the grid, and option B beside A.
    shadow_backup_held_import_kwh: b?.heldImport?.kwh ?? null,
    shadow_backup_held_net_usd: b?.heldImport?.netUsd ?? null,
    shadow_cost_held_import_kwh: c?.heldImport?.kwh ?? null,
    shadow_cost_held_net_usd: c?.heldImport?.netUsd ?? null,
    shadow_backup_b_setpoint_pct: rec.backupB?.reservePct ?? null,
    shadow_backup_b_expected_buy_kwh: rec.backupB?.expectedBuyKwh ?? null,
    shadow_backup_b_held_import_kwh: rec.backupB?.heldImport?.kwh ?? null,
    shadow_backup_b_held_net_usd: rec.backupB?.heldImport?.netUsd ?? null,
  };
}

/** The refresh's shadow columns. PURE. */
export function middayShadowRefreshLedgerColumns(r: ShadowRefresh): Partial<NightLedgerRow> {
  return {
    shadow_refresh_weather_age_s: r.weatherAgeS ?? null,
    shadow_refreshed_at_ms: r.atMs,
    shadow_refresh_disposition: r.disposition,
    shadow_refreshed_level_pct: r.levelPct,
    shadow_refreshed_reserve_pct: r.reservePct,
    shadow_refreshed_buy_kwh: r.buyKwh,
    shadow_refreshed_expected_buy_kwh: r.expectedBuyKwh,
  };
}

const kwh = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 10) / 10} kWh`);
const pct = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
const at = (ms: number): string => new Date(ms).toISOString();
const usd = (v: number): string => `$${Math.abs(v).toFixed(2)}`;

/** What a leg's hold sends to the grid, for its log line ('' when it holds nothing). PURE. */
export function heldImportText(h: HeldImport | null | undefined): string {
  if (h == null) return '';
  const bill = h.netUsd == null
    ? 'not priced (the rates are not confirmed)'
    : h.netUsd > 0
      ? `adding ~${usd(h.netUsd)} to the bill against buying it back in the mid-day window`
      : h.netUsd < 0 ? `saving ~${usd(h.netUsd)} against buying it back in the mid-day window` : 'costing nothing net';
  return ` Held ${at(h.fromMs)}→${at(h.untilMs)}, the reserve sends ~${kwh(h.kwh)} of house load to the grid (median load and PV), ${bill}.`;
}

/** What the chooser's reason means, for the log. */
export const SHADOW_WHY_TEXT: Readonly<Record<ChargeCycleWhy, string>> = Object.freeze({
  midday: 'the super off-peak window carries the cost buy',
  'overnight-configured': 'the cost window is configured overnight',
  'not-cost-objective': 'ARB_OBJECTIVE is not cost, so the overnight cycle stays',
  'ceiling-at-reserve': 'ARB_COST_MAX_SOC_PCT is at or below the 50% reserve maximum',
  'no-run-in-scan': 'no super off-peak window opens within 30 h (a Friday, a Saturday, a holiday eve or summer)',
  'season-grace': 'the window falls in the first days of the winter season, still billed on the summer cycle',
  'rate-veto': 'the confirmed rates price super off-peak at or above overnight',
});

/** The evening's log lines, each starting with MIDDAY_SHADOW_LOG_TAG. PURE. */
export function middayShadowLogLines(rec: MiddayShadowRecord): string[] {
  const t = MIDDAY_SHADOW_LOG_TAG;
  if (rec.cost == null) {
    return [`${t} ${rec.day} — no mid-day cycle (${rec.why}: ${SHADOW_WHY_TEXT[rec.why]}); nothing to compute.${rec.note ? ` ${rec.note}` : ''}`];
  }
  const out: string[] = [];
  const b = rec.backup;
  if (b != null) {
    out.push(`${t} ${rec.day} backup ${at(b.windowStartMs)}→${at(b.windowEndMs)} — ${b.disposition}: reserve ${pct(b.reservePct)}, `
      + `expected ${kwh(b.expectedBuyKwh)} (worst-case sizing ${kwh(b.buyKwh)}); the islanded walk it is sized on, to the next overnight open, troughs at ${pct(b.cushionTroughSocPct)} against the ${pct(b.cushionLineSocPct)} line.${heldImportText(b.heldImport)} Shadow only: nothing is armed, written or announced for it.`);
  }
  const bb = rec.backupB;
  if (bb != null) {
    out.push(`${t} ${rec.day} backup ${bb.disposition} — ${bb.chargeTonight ? `reserve ${pct(bb.reservePct)}, expected ${kwh(bb.expectedBuyKwh)} (worst-case sizing ${kwh(bb.buyKwh)})` : 'it would hold (no write)'}; `
      + `its walk to the mid-day open troughs at ${pct(bb.cushionTroughSocPct)} against the ${pct(bb.cushionLineSocPct)} line.${heldImportText(bb.heldImport)} Shadow only.`);
  }
  const c = rec.cost;
  out.push(`${t} ${rec.day} cost ${at(c.windowStartMs)}→${at(c.windowEndMs)} — ${c.disposition}: reserve ${pct(c.reservePct)} (T_mid: ${c.reserveBasis ?? '—'}), `
    + `level ~${pct(c.levelPct)} (ceiling ${pct(c.costCeilingSocPct)}), expected ${kwh(c.expectedBuyKwh)} (worst-case sizing ${kwh(c.buyKwh)}) from ~${pct(c.expectedStartSocPct)} at the open; `
    + `planned window PV ${kwh(c.windowPvP50Kwh)}, load ${kwh(c.windowLoadP50Kwh)}.${heldImportText(c.heldImport)} Shadow only: nothing is armed, written or announced for it.`);
  return out;
}

/** The refresh's log line. PURE. */
export function middayShadowRefreshLogLine(rec: MiddayShadowRecord, r: ShadowRefresh): string {
  const age = r.weatherAgeS != null ? `; sized on weather ${Math.round(r.weatherAgeS / 60)} min old` : '';
  return `${MIDDAY_SHADOW_LOG_TAG} ${rec.day} refresh — ${r.disposition}: ${r.reason}; level ~${pct(r.levelPct)}, reserve ${pct(r.reservePct)}, `
    + `expected ${kwh(r.expectedBuyKwh)}${age}${r.wouldPush ? '; a live refresh would push this' : ''}. Shadow only: nothing is written or pushed.`;
}

/* ── the words (R5): what the evening and the refresh would say — never sent ──────── */

/** The evening notice's inputs for the shadow's cycle, as the evening job would build them once the
 *  switch arms it (chargeText.MiddayAnnounceInput); null with no mid-day leg. PURE. */
export function middayShadowAnnounceInput(rec: MiddayShadowRecord, model: TariffModel): MiddayAnnounceInput | null {
  const c = rec.cost;
  if (c == null) return null;
  const b = rec.backup;
  const advisory = rec.mode === 'advisory';
  const onPeakStart = nextOnPeakStartMs(model, c.windowStartMs);
  const onPeak = onPeakStart != null ? { startMs: onPeakStart, endMs: onPeakEndMs(model, onPeakStart) } : null;
  // A write mode that would not arm a cost leg that charges: the cycle is refused, with the probe's words.
  const refusedPrefix = 'would not arm — ';
  const refused = !advisory && c.basisComplete && c.chargeTonight && !c.wouldArm
    ? (c.disposition.startsWith(refusedPrefix) ? c.disposition.slice(refusedPrefix.length) : c.disposition) : null;
  // The backup the notice names: the one that would arm; in advisory mode the one the plan calls for;
  // in a refused cycle the one the plan called for ("no outage backup tonight because …").
  const backupNamed = b != null && b.basisComplete && b.chargeTonight && (advisory || refused != null || b.wouldArm);
  const forceCharge = c.levelPct != null && c.reservePct != null && c.levelPct > c.reservePct + 0.05;
  return {
    nowMs: rec.computedAtMs,
    mode: rec.mode,
    cost: {
      windowStartMs: c.windowStartMs, windowEndMs: c.windowEndMs,
      levelPct: c.levelPct, reservePct: c.reservePct, expectedKwh: c.expectedBuyKwh, buyKwh: c.buyKwh,
      toward: c.toward === true, forceCharge, charges: c.chargeTonight, basisComplete: c.basisComplete,
      cushionShortfall: c.cushionShortfall === true,
    },
    backup: backupNamed && b != null ? {
      windowStartMs: b.windowStartMs, windowEndMs: b.windowEndMs, reservePct: b.reservePct,
      expectedKwh: b.expectedBuyKwh, buyKwh: b.buyKwh, cushionShortfall: b.cushionShortfall === true,
    } : null,
    onPeak,
    refreshAtMs: c.windowStartMs - REFRESH_LEAD_MS,
    costApplyAtMs: c.windowStartMs - APPLY_LEAD_MS,
    backupApplyAtMs: b != null ? b.windowStartMs - APPLY_LEAD_MS : null,
    costRestoreAtMs: revertDueMs({ windowEndMs: c.windowEndMs, nextOnPeakStartMs: onPeakStart }) ?? c.windowEndMs,
    refused,
  };
}

/** What the evening would have said for the shadow's cycle: its push, its spoken pair (null when
 *  nothing would be spoken) and that pair's length. Never sent. PURE. */
export interface MiddayShadowPreview {
  push: NotifyMessage;
  spoken: { en: string; es: string } | null;
  spokenChars: number | null;
}

export function middayShadowPreview(rec: MiddayShadowRecord | null, model: TariffModel): MiddayShadowPreview | null {
  const i = rec != null ? middayShadowAnnounceInput(rec, model) : null;
  if (i == null) return null;
  const a = eveningAnnouncement({ cycle: 'midday', midday: i });
  return { push: a.push, spoken: a.spoken, spokenChars: a.spoken != null ? a.spoken.en.length + a.spoken.es.length : null };
}

/** The preview's log lines — each tagged, each saying it was not sent. PURE. */
export function middayShadowPreviewLogLines(rec: MiddayShadowRecord, model: TariffModel): string[] {
  const p = middayShadowPreview(rec, model);
  if (p == null) return [];
  const t = MIDDAY_SHADOW_LOG_TAG;
  const out = [`${t} ${rec.day} the 21:30 push would read (not sent): "${p.push.title}" — ${p.push.body}`];
  if (p.spoken != null) {
    out.push(`${t} ${rec.day} the notice would be spoken (not spoken; ${p.spokenChars} of ${MAX_SPOKEN_ADVISORY_CHARS} characters): "${p.spoken.en}" / "${p.spoken.es}"`);
  }
  return out;
}

/** The refresh push a live refresh would send (null when it would send none). Never sent. PURE. */
export function middayShadowRefreshPreview(rec: MiddayShadowRecord, r: ShadowRefresh): NotifyMessage | null {
  const c = rec.cost;
  if (c == null || r.disposition === 'not-comparable') return null;
  return buildMiddayRefreshMessage({
    nowMs: r.atMs,
    windowStartMs: c.windowStartMs, windowEndMs: c.windowEndMs,
    announcedAtMs: rec.computedAtMs,
    disposition: r.disposition,
    announced: { levelPct: c.levelPct, expectedKwh: c.expectedBuyKwh },
    refreshed: { levelPct: r.levelPct, reservePct: r.reservePct, expectedKwh: r.expectedBuyKwh },
    neededLevelPct: r.neededLevelPct ?? null,
    neededReservePct: r.neededReservePct ?? null,
    windowPvKwh: { announced: c.windowPvP50Kwh, refreshed: r.windowPvP50Kwh ?? null },
    reservePct: null,
    applyAtMs: c.windowStartMs - APPLY_LEAD_MS,
    wouldPush: r.wouldPush,
  });
}

/** The refresh preview's log line, or null when a live refresh would push nothing. PURE. */
export function middayShadowRefreshPreviewLogLine(rec: MiddayShadowRecord, r: ShadowRefresh): string | null {
  const m = middayShadowRefreshPreview(rec, r);
  return m == null ? null : `${MIDDAY_SHADOW_LOG_TAG} ${rec.day} the refresh push would read (not sent): "${m.title}" — ${m.body}`;
}

/* ── the file ─────────────────────────────────────────────────────────────── */

const coerceLeg = (raw: unknown): ShadowLegSummary | null => {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ws = fin(o.windowStartMs);
  const we = fin(o.windowEndMs);
  if (ws == null || we == null || !(we > ws)) return null;
  const basis = o.reserveBasis;
  return {
    role: o.role === 'cost' ? 'cost' : 'backup',
    kind: o.kind === 'super_off_peak' ? 'super_off_peak' : 'overnight',
    windowStartMs: ws, windowEndMs: we,
    basisComplete: o.basisComplete === true, chargeTonight: o.chargeTonight === true,
    reservePct: fin(o.reservePct),
    reserveBasis: basis === 'floor' || basis === 'line' || basis === 'pool' || basis === 'resilience' ? basis : null,
    levelPct: fin(o.levelPct), costCeilingSocPct: fin(o.costCeilingSocPct),
    buyKwh: fin(o.buyKwh), expectedBuyKwh: fin(o.expectedBuyKwh), expectedStartSocPct: fin(o.expectedStartSocPct),
    cushionTroughSocPct: fin(o.cushionTroughSocPct), cushionLineSocPct: fin(o.cushionLineSocPct),
    wouldArm: o.wouldArm === true,
    disposition: typeof o.disposition === 'string' ? o.disposition : '',
    windowPvP50Kwh: fin(o.windowPvP50Kwh), windowLoadP50Kwh: fin(o.windowLoadP50Kwh),
    ...(typeof o.toward === 'boolean' ? { toward: o.toward } : {}),
    ...(typeof o.cushionShortfall === 'boolean' ? { cushionShortfall: o.cushionShortfall } : {}),
    ...('heldImport' in o ? { heldImport: coerceHeldImport(o.heldImport) } : {}),
  };
};

const coerceHeldImport = (raw: unknown): HeldImport | null => {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fromMs = fin(o.fromMs);
  const untilMs = fin(o.untilMs);
  const kwh = fin(o.kwh);
  if (fromMs == null || untilMs == null || kwh == null) return null;
  return { fromMs, untilMs, kwh, importUsd: fin(o.importUsd), creditUsd: fin(o.creditUsd), netUsd: fin(o.netUsd) };
};

const DISPOSITIONS: readonly ShadowRefreshDisposition[] = ['unchanged', 'lowered', 'capped', 'cancelled', 'stood', 'not-comparable'];
const WHYS: readonly ChargeCycleWhy[] = Object.keys(SHADOW_WHY_TEXT) as ChargeCycleWhy[];

/** A persisted shadow record read back (restart path): anything malformed is no record. PURE. */
export function coerceMiddayShadowRecord(raw: unknown): MiddayShadowRecord | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const computedAtMs = fin(o.computedAtMs);
  if (o.version !== MIDDAY_SHADOW_VERSION || typeof o.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.day) || computedAtMs == null) return null;
  if (!WHYS.includes(o.why as ChargeCycleWhy)) return null;
  const r = o.refresh != null && typeof o.refresh === 'object' ? o.refresh as Record<string, unknown> : null;
  const refresh: ShadowRefresh | null = r != null && fin(r.atMs) != null && DISPOSITIONS.includes(r.disposition as ShadowRefreshDisposition)
    ? {
      atMs: fin(r.atMs)!, disposition: r.disposition as ShadowRefreshDisposition,
      levelPct: fin(r.levelPct), reservePct: fin(r.reservePct), buyKwh: fin(r.buyKwh), expectedBuyKwh: fin(r.expectedBuyKwh),
      wouldPush: r.wouldPush === true, reason: typeof r.reason === 'string' ? r.reason : '',
      ...('weatherAgeS' in r ? { weatherAgeS: fin(r.weatherAgeS) } : {}),
      ...('neededLevelPct' in r ? { neededLevelPct: fin(r.neededLevelPct) } : {}),
      ...('windowPvP50Kwh' in r ? { windowPvP50Kwh: fin(r.windowPvP50Kwh) } : {}),
      ...('neededReservePct' in r ? { neededReservePct: fin(r.neededReservePct) } : {}),
    }
    : null;
  return {
    version: MIDDAY_SHADOW_VERSION, day: o.day, computedAtMs, why: o.why as ChargeCycleWhy,
    mode: o.mode === 'supervised' || o.mode === 'auto' ? o.mode : 'advisory',
    backup: coerceLeg(o.backup),
    ...('backupB' in o ? { backupB: coerceLeg(o.backupB) } : {}),
    cost: coerceLeg(o.cost), refresh,
    note: typeof o.note === 'string' ? o.note : null,
  };
}

/* ── the holder the surfaces read ─────────────────────────────────────────── */

let latestShadow: MiddayShadowRecord | null = null;
/** The current shadow record (index.ts sets it after each evening and refresh, and at boot). */
export function getMiddayShadow(): MiddayShadowRecord | null {
  return latestShadow;
}
export function setMiddayShadow(r: MiddayShadowRecord | null): void {
  latestShadow = r;
}
