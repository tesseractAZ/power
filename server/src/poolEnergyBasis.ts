/**
 * v1.187.19 — the backup pool's MEASURED energy basis for the runway, the forecast SoC
 * trajectory and the alarms that read them.
 *
 * WHY. The SHP2's pool percent (`backupBatPercent`, each source's `batteryPercentage`) is a
 * fraction of the packs' BMS FULL-CHARGE capacity (Σ fullCapMah), not of their nameplate. The
 * panel turns it into energy against nameplate (`backupRemainWh = pct × backupFullCapWh`,
 * 30,720 Wh per Core), so every kWh figure derived from it is high by the packs' capacity
 * ratio — 0.944 on 2026-10-01 (849,556 / 900,000 mAh). A runway built on those kWh counts down
 * too slowly. Replayed over 30 clean pack-only discharge spans (2026-09-02..10-11) the old
 * runway overstated the hours in every one, by 7 to 19 %; see docs/PERFORMANCE.md §4a and
 * test/fixtures/runwayReplaySpans.json.
 *
 * WHAT. `capacityScale` = the capacity-weighted mean, over the Cores the panel lists as
 * CONNECTED sources (`sources[].isConnected` — never the online DPUs, never a spare list, so a
 * bench Core cannot lend the pool its fresher packs), of each Core's Σ fullCapMah / Σ
 * designCapMah over its packs. With every Core reporting it equals Σ fullCapMah × 102.4 V ÷
 * backupFullCapWh (each pack's design 60,000 mAh × 102.4 V is its 6,144 Wh nameplate). It
 * multiplies the panel's nameplate energies; the percent itself is already on the measured
 * basis and is never rescaled.
 *
 * Fail-safe shape, each deliberate (the optimistic direction is a LONGER runway):
 * - Clamped to [CAPACITY_SCALE_MIN, CAPACITY_SCALE_MAX]: never above nameplate.
 * - A pack whose fullCapMah is null, ≤ 0, or above PACK_FULL_CAP_MAX_OF_DESIGN × its design is
 *   invalid, and a Core with any invalid pack, a pack count that disagrees with its own
 *   `packCount`, or no live reading (offline, not yet reported) is INCOMPLETE. An incomplete
 *   Core uses its last complete ratio — persisted (POOL_ENERGY_BASIS_DIR, else beside the
 *   database under the Supervisor) and valid for HELD_RATIO_MAX_AGE_MS; past that, or never
 *   seen, the LOWEST ratio known for any Core. Plain nameplate (1.0) only
 *   when no ratio has ever been measured: once one exists the basis never silently returns to
 *   nameplate.
 * - Asymmetric: a lower figure applies at once; a higher one only after it has held for
 *   CAPACITY_INCREASE_HOLD_MS (a BMS recalibration upward, or a better Core swapped into a slot,
 *   waits a day; the figure applied is the lowest seen during the hold). Only a COMPLETE
 *   measurement (every connected Core reporting) moves the applied figure or its hold; a figure
 *   built on substitutes is answered as min(applied, it) and not recorded, so a partial map at a
 *   restart can neither lengthen the runway nor plant a low figure the full map must wait out.
 * - Not a report result: the worker's basis reset (resetWorkerReportCaches) leaves it alone, like
 *   the runway's carried load; it is persisted measured state.
 *
 * THREADING. computeRunway / getDayForecast / computeMultiDayForecast run in the analytics
 * WORKER; they share the worker's tracker (analytics.ts), which is the only writer of
 * pool-energy-basis.json. A secondary panel's drain runway (panelRunway.ts) runs on the main
 * thread with its own tracker and its own file. v1.199.0 — so does the night-charge cushion line:
 * index.ts keeps a third tracker for the house panel (pool-energy-basis-cushion.json), evaluated by
 * the planner from its own snapshot, whose scale converts the outage cushion to the panel's percent
 * (nightChargeAdvisor.ts cushionLineKwh); v1.202.0 — and counts the night-charge plan's pool on
 * (plannerPoolKwh: every walk of the plan). The state is read and written in the thread that
 * evaluates it — never set on one thread and read on the other.
 * v1.203.0 — the cushion tracker is SEEDED from the worker's file (seedPath), read-only, while it has no ratio of its own: it
 * arrived after the Cores went dark on the vendor cloud and never saw one, so it answered 'nameplate' while the runway counted the
 * pool on the Cores' held ratios. The seed is the per-Core ratios at their own timestamps, never the worker's panel figures, and
 * the worker's file is still written by the worker alone.
 * v1.207.0 — a FOURTH tracker, the recorder's (recorder.ts, main thread), for the energy bridge: its own file
 * (pool-energy-basis-bridge.json), the same read-only seed, and `persistSeed`, so the seeded ratios are written to its own file
 * at first load and later boots do not depend on the worker's file. The bridge reads each connected Core's ratio from it
 * (coreRatios), never a scale; that call records the live ratios as evaluate() does and never reads or moves a panel's applied
 * scale or its increase hold. The recorder hands it only the Cores that are not dark to the bridge, so a dark Core's ratio is
 * the held one and is never re-measured from a body that is not a reading.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';
import { DPU_PACK_NOMINAL_V } from './hwSpec.js';
import { limits } from './limits.js';

/** One pack's nominal string voltage: 32 LFP cells × 3.2 V. mAh × V / 1000 = Wh (hwSpec.ts since v1.191.0). */
export const PACK_NOMINAL_V = DPU_PACK_NOMINAL_V;
/** v1.191.0 (Z1) — the CAPACITY_SCALE_MIN option (limits.ts; 0.8 while unset, clamped to 0.5..1): the
 *  one floor of the measured scale, imported by panelRunway.ts and alertMonitor.ts as well. Read once,
 *  at import, in each thread that loads this module. */
export const CAPACITY_SCALE_MIN = limits.capacityScaleMin;
export const CAPACITY_SCALE_MAX = 1;
/** A pack reporting more than this × its design capacity is a bad reading, not a better pack. */
export const PACK_FULL_CAP_MAX_OF_DESIGN = 1.1;
export const CAPACITY_INCREASE_HOLD_MS = 24 * 60 * 60 * 1000;
export const HELD_RATIO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A live ratio's timestamp is re-persisted at most this often while the ratio is unchanged. */
const RATIO_TOUCH_PERSIST_MS = 60 * 60 * 1000;

/** How the applied scale was obtained, worst input first: 'nameplate' — no ratio has ever been
 *  measured; 'min-known' — a Core had no usable held ratio and took the lowest known one;
 *  'held' — a Core was not reporting and used its persisted ratio; 'measured' — every connected
 *  Core reported complete packs now. */
export type CapacityBasis = 'measured' | 'held' | 'min-known' | 'nameplate';

export interface PoolEnergyBasis {
  /** Applied multiplier on the panel's nameplate energies (after the increase hold). */
  capacityScale: number;
  capacityBasis: CapacityBasis;
  /** Connected sources counted (the panel's own `sources[].isConnected`). */
  connectedCores: number;
  /** This evaluation's figure before the increase hold (diagnostic). */
  candidateScale: number;
  /** Set while a higher candidate is waiting out CAPACITY_INCREASE_HOLD_MS. */
  increaseHeldSinceMs: number | null;
}

/** The nameplate basis: what every figure meant before v1.187.19. */
export const NAMEPLATE_BASIS: PoolEnergyBasis = Object.freeze({
  capacityScale: 1, capacityBasis: 'nameplate', connectedCores: 0, candidateScale: 1, increaseHeldSinceMs: null,
}) as PoolEnergyBasis;

const clampScale = (x: number): number => Math.min(CAPACITY_SCALE_MAX, Math.max(CAPACITY_SCALE_MIN, x));

/**
 * PURE. A Core's measured capacity ratio Σ fullCapMah / Σ designCapMah, or null when its reading
 * is incomplete: not online, not a DPU projection, no packs, a pack count that disagrees with the
 * Core's own `packCount`, or any pack with a missing, non-positive or implausible capacity.
 */
export function coreCapacityRatio(d: DeviceSnapshot | undefined): number | null {
  if (!d || d.online !== true) return null;
  const p = d.projection;
  if (!p || p.kind !== 'dpu') return null;
  const packs = p.packs ?? [];
  if (packs.length === 0) return null;
  if (p.packCount != null && Number.isInteger(p.packCount) && p.packCount >= 1 && packs.length !== p.packCount) return null;
  let full = 0;
  let design = 0;
  for (const pk of packs) {
    const f = pk.fullCapMah;
    const dc = pk.designCapMah;
    if (f == null || dc == null || !Number.isFinite(f) || !Number.isFinite(dc)) return null;
    if (f <= 0 || dc <= 0 || f > PACK_FULL_CAP_MAX_OF_DESIGN * dc) return null;
    full += f;
    design += dc;
  }
  return full / design;
}

export interface HeldRatio { ratio: number; atMs: number }

/** v1.207.0 — one connected Core's capacity ratio as the candidate scale took it (not clamped). */
export interface CoreRatio {
  ratio: number;
  basis: CapacityBasis;
  /** When it was measured: the evaluation instant ('measured'), the held entry's time ('held'); null for 'min-known' and
   *  'nameplate'. */
  atMs: number | null;
}

/**
 * PURE. This instant's candidate scale for one panel, before the increase hold. `held` is read,
 * never written (the tracker records the live ratios this returns).
 */
export function candidatePoolScale(
  panel: { projection: Pick<Shp2Projection, 'sources'> },
  devices: Record<string, DeviceSnapshot>,
  held: ReadonlyMap<string, HeldRatio>,
  nowMs: number,
  maxHeldAgeMs = HELD_RATIO_MAX_AGE_MS,
): { scale: number; basis: CapacityBasis; connected: number; live: Map<string, number>; perCore?: Map<string, CoreRatio> } {
  const connected = (panel.projection.sources ?? []).filter(
    (s) => s?.isConnected === true && typeof s.sn === 'string' && s.sn.length > 0,
  );
  const live = new Map<string, number>();
  const known: number[] = [];
  for (const h of held.values()) if (Number.isFinite(h.ratio) && h.ratio > 0) known.push(h.ratio);
  const perCore: Array<{ sn: string; ratio: number | null; basis: CapacityBasis; weight: number | null }> = [];
  for (const src of connected) {
    const sn = src.sn as string;
    const weight = typeof src.fullCap === 'number' && Number.isFinite(src.fullCap) && src.fullCap > 0 ? src.fullCap : null;
    const r = coreCapacityRatio(devices[sn]);
    if (r != null) {
      live.set(sn, r);
      known.push(r);
      perCore.push({ sn, ratio: r, basis: 'measured', weight });
      continue;
    }
    const h = held.get(sn);
    if (h && Number.isFinite(h.ratio) && h.ratio > 0 && nowMs - h.atMs <= maxHeldAgeMs) {
      perCore.push({ sn, ratio: h.ratio, basis: 'held', weight });
    } else {
      perCore.push({ sn, ratio: null, basis: 'min-known', weight });
    }
  }
  const minKnown = known.length > 0 ? Math.min(...known) : null;
  if (perCore.length === 0) {
    // No connected source to weigh: the lowest ratio ever measured, else nameplate.
    return minKnown != null
      ? { scale: clampScale(minKnown), basis: 'min-known', connected: 0, live }
      : { scale: 1, basis: 'nameplate', connected: 0, live };
  }
  const rank: Record<CapacityBasis, number> = { measured: 0, held: 1, 'min-known': 2, nameplate: 3 };
  let basis: CapacityBasis = 'measured';
  const useWeights = perCore.every((c) => c.weight != null);
  let num = 0;
  let den = 0;
  // v1.207.0 — each connected Core's ratio as this loop takes it (coreRatios, the energy bridge's input). Built here only, and
  // returned on the main return only: with no connected source there is no Core to answer for.
  const resolved = new Map<string, CoreRatio>();
  for (const c of perCore) {
    let ratio = c.ratio;
    let b = c.basis;
    if (ratio == null) {
      if (minKnown != null) ratio = minKnown;
      else { ratio = 1; b = 'nameplate'; }
    }
    resolved.set(c.sn, { ratio, basis: b, atMs: b === 'measured' ? nowMs : b === 'held' ? (held.get(c.sn)?.atMs ?? null) : null });
    if (rank[b] > rank[basis]) basis = b;
    const w = useWeights ? (c.weight as number) : 1;
    num += ratio * w;
    den += w;
  }
  return { scale: clampScale(num / den), basis, connected: perCore.length, live, perCore: resolved };
}

interface PanelHold { scale: number; pendingScale: number | null; pendingSinceMs: number | null }
interface PersistShape { v: 1; cores: Record<string, HeldRatio>; panels: Record<string, PanelHold> }

/** Where a tracker persists: `<name>.json` in POOL_ENERGY_BASIS_DIR ('' disables), else next to
 *  the database under the Supervisor, else nowhere (tests, local runs). One file per name, so
 *  the worker's and the main thread's trackers never write the same file. */
export function defaultPoolEnergyBasisPath(name: string): string | null {
  const dir = process.env.POOL_ENERGY_BASIS_DIR;
  if (dir != null) return dir === '' ? null : resolve(dir, `${name}.json`);
  return process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', `${name}.json`) : null;
}

export interface PoolEnergyBasisTrackerOptions {
  /** Persistence file; null/'' = in memory only. */
  path?: string | null;
  /** v1.203.0 — another tracker's file to SEED from, read-only, at load: only while this tracker has no ratio of its own (its own
   *  file holds no Core), the other file's per-Core ratios are taken with their original timestamps, so they age out
   *  (HELD_RATIO_MAX_AGE_MS) on that tracker's own schedule. Never its panels' applied figures, never written back; a missing or
   *  corrupt file seeds nothing. A seeded entry reaches this tracker's own file only with a live reading's save (unless
   *  persistSeed). null/'' = none. */
  seedPath?: string | null;
  /** v1.207.0 — write the seeded entries to this tracker's OWN file at first load (when its own file holds no Core and the
   *  seed file does), each `{ ratio, atMs }` as the seed recorded it, so later boots read them from the own file and do not
   *  depend on the seed file. Used by the energy bridge's tracker alone (recorder.ts): its Cores may stay dark for months, and
   *  without it a seeded entry reached the own file only when a Core reported again. Default false: the other trackers keep
   *  the v1.203.0 behaviour. The seed file is still never written. */
  persistSeed?: boolean;
  holdMs?: number;
  maxHeldAgeMs?: number;
}

/** The stateful half: held per-Core ratios and each panel's applied scale (asymmetric). */
export class PoolEnergyBasisTracker {
  private readonly path: string | null;
  private readonly seedPath: string | null;
  private readonly persistSeed: boolean;
  private readonly holdMs: number;
  private readonly maxHeldAgeMs: number;
  private loaded = false;
  private cores = new Map<string, HeldRatio>();
  private panels = new Map<string, PanelHold>();
  private persistedAtMs = new Map<string, number>();

  constructor(opts: PoolEnergyBasisTrackerOptions = {}) {
    this.path = opts.path ? opts.path : null;
    this.seedPath = opts.seedPath ? opts.seedPath : null;
    this.persistSeed = opts.persistSeed === true;
    this.holdMs = opts.holdMs ?? CAPACITY_INCREASE_HOLD_MS;
    this.maxHeldAgeMs = opts.maxHeldAgeMs ?? HELD_RATIO_MAX_AGE_MS;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadOwn();
    const own = this.cores.size;
    if (this.cores.size === 0) this.loadSeed();
    // v1.207.0 — persistSeed: the entries just adopted go to this tracker's own file now, not at a Core's next live reading.
    if (this.persistSeed && own === 0 && this.cores.size > 0) this.save();
  }

  /** v1.203.0 — the seed (seedPath): the other file's valid per-Core ratios, `{ ratio, atMs }` as recorded. Not marked persisted
   *  (persistedAtMs), and the panels' figures are never read. */
  private loadSeed(): void {
    if (!this.seedPath) return;
    try {
      if (!existsSync(this.seedPath)) return;
      const raw = JSON.parse(readFileSync(this.seedPath, 'utf8')) as Partial<PersistShape>;
      for (const [sn, h] of Object.entries(raw?.cores ?? {})) {
        if (h && Number.isFinite(h.ratio) && h.ratio > 0 && Number.isFinite(h.atMs)) this.cores.set(sn, { ratio: h.ratio, atMs: h.atMs });
      }
    } catch { /* absent or corrupt → no seed: nameplate, as before */ }
  }

  private loadOwn(): void {
    if (!this.path) return;
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistShape>;
      for (const [sn, h] of Object.entries(raw?.cores ?? {})) {
        if (h && Number.isFinite(h.ratio) && h.ratio > 0 && Number.isFinite(h.atMs)) {
          this.cores.set(sn, { ratio: h.ratio, atMs: h.atMs });
          this.persistedAtMs.set(sn, h.atMs);
        }
      }
      for (const [sn, p] of Object.entries(raw?.panels ?? {})) {
        if (!p || !Number.isFinite(p.scale)) continue;
        const pending = p.pendingScale != null && Number.isFinite(p.pendingScale) && p.pendingSinceMs != null && Number.isFinite(p.pendingSinceMs);
        this.panels.set(sn, {
          scale: clampScale(p.scale),
          pendingScale: pending ? p.pendingScale! : null,
          pendingSinceMs: pending ? p.pendingSinceMs! : null,
        });
      }
    } catch { /* absent or corrupt → start without; the first complete reading re-measures */ }
  }

  private save(): void {
    if (!this.path) return;
    const out: PersistShape = { v: 1, cores: Object.fromEntries(this.cores), panels: Object.fromEntries(this.panels) };
    try { atomicWriteFileSync(this.path, JSON.stringify(out)); } catch { /* best effort; retried on the next change */ }
  }

  /** Record this evaluation's live ratios as the held entries (evaluate()'s first step, v1.207.0: shared with coreRatios).
   *  true = something to persist: a new Core, a changed ratio, or a timestamp RATIO_TOUCH_PERSIST_MS past its last write. */
  private recordLive(live: ReadonlyMap<string, number>, nowMs: number): boolean {
    let dirty = false;
    for (const [sn, ratio] of live) {
      const prev = this.cores.get(sn);
      this.cores.set(sn, { ratio, atMs: nowMs });
      if (!prev || Math.abs(prev.ratio - ratio) > 1e-6 || nowMs - (this.persistedAtMs.get(sn) ?? -Infinity) >= RATIO_TOUCH_PERSIST_MS) {
        this.persistedAtMs.set(sn, nowMs);
        dirty = true;
      }
    }
    return dirty;
  }

  /** v1.207.0 — each connected Core's ratio for `panel` at `nowMs`, by the candidate scale's own per-Core rule. Records the live
   *  ratios as evaluate() does; never reads or moves a panel's applied scale or its increase hold. The energy bridge's input
   *  (recorder.ts), which passes no age limit: swapping in the lowest known ratio after HELD_RATIO_MAX_AGE_MS is the pool
   *  figures' safe direction, not a better estimate of that Core. Empty when the panel lists no connected source. */
  coreRatios(devices: Record<string, DeviceSnapshot>, panel: { projection: Pick<Shp2Projection, 'sources'> }, nowMs: number,
    maxHeldAgeMs: number = this.maxHeldAgeMs): ReadonlyMap<string, CoreRatio> {
    this.load();
    const cand = candidatePoolScale(panel, devices, this.cores, nowMs, maxHeldAgeMs);
    if (this.recordLive(cand.live, nowMs)) this.save();
    return cand.perCore ?? new Map();
  }

  /** The basis for `panel` from `devices` at `nowMs` — read the remaining/full energies from the
   *  SAME snapshot, with no await in between. */
  evaluate(devices: Record<string, DeviceSnapshot>, panel: DeviceSnapshot & { projection: Shp2Projection }, nowMs: number): PoolEnergyBasis {
    this.load();
    const cand = candidatePoolScale(panel, devices, this.cores, nowMs, this.maxHeldAgeMs);
    let dirty = this.recordLive(cand.live, nowMs);
    const prev = this.panels.get(panel.sn);
    if (cand.basis !== 'measured') {
      // A figure built on SUBSTITUTES — a connected Core not reporting (a restart while the Cores
      // report in, a cloud-offline Core) took its held ratio, the lowest known, or nameplate — is
      // this instant's answer, never above the applied figure, but it is not recorded: the
      // increase hold runs only between complete measurements. Recorded, a partial boot map
      // (one Core projected, the others on the lowest known ratio) planted a low figure that the
      // first full map then had to wait 24 h out.
      if (dirty) this.save();
      return {
        capacityScale: prev ? Math.min(prev.scale, cand.scale) : cand.scale,
        capacityBasis: cand.basis,
        connectedCores: cand.connected,
        candidateScale: cand.scale,
        increaseHeldSinceMs: prev?.pendingSinceMs ?? null,
      };
    }
    let next: PanelHold;
    if (!prev || cand.scale <= prev.scale) {
      // First figure for this panel, or a decrease (or no change): applies at once.
      next = { scale: cand.scale, pendingScale: null, pendingSinceMs: null };
    } else {
      // An increase waits out the hold, at the lowest figure seen while waiting.
      const since = prev.pendingSinceMs ?? nowMs;
      const pend = prev.pendingScale != null ? Math.min(prev.pendingScale, cand.scale) : cand.scale;
      next = nowMs - since >= this.holdMs
        ? { scale: pend, pendingScale: null, pendingSinceMs: null }
        : { scale: prev.scale, pendingScale: pend, pendingSinceMs: since };
    }
    if (!prev || prev.scale !== next.scale || prev.pendingScale !== next.pendingScale || prev.pendingSinceMs !== next.pendingSinceMs) dirty = true;
    this.panels.set(panel.sn, next);
    if (dirty) this.save();
    return {
      capacityScale: next.scale,
      capacityBasis: cand.basis,
      connectedCores: cand.connected,
      candidateScale: cand.scale,
      increaseHeldSinceMs: next.pendingSinceMs,
    };
  }

  /** Test seam: forget everything (and stop treating the file as loaded). */
  reset(): void {
    this.loaded = false;
    this.cores.clear();
    this.panels.clear();
    this.persistedAtMs.clear();
  }
}
