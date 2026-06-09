/**
 * haStateCache.ts — a TTL-gated read cache over Home Assistant entity states.
 *
 * The load-shedding advisor needs to know which household devices are on and how
 * many watts they draw, so it can decompose the opaque SHP2 `panel_load` number
 * into named contributors and simulate "what if we shed the pool pump?". Polling
 * HA's full state list on every decision tick would be wasteful, so this wraps
 * getAllStates() (haService.ts) behind a short TTL (default 30s) — plenty fresh
 * for runway decisions that operate on hours-scale projections.
 *
 * READ-ONLY. This module never calls a service or mutates HA state — it only
 * reads. All HTTP + Supervisor-token handling stays in haService.ts.
 */
import { getAllStates } from './haService.js';

export interface CachedEntity {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  /** Best-effort instantaneous power in watts, or null if not derivable. */
  watts: number | null;
  fetchedAt: number;
}

const TTL_MS = Number(process.env.HA_STATE_CACHE_TTL_MS ?? 30_000);

let cache = new Map<string, CachedEntity>();
let lastFetchedAt = 0;
let inflight: Promise<void> | null = null;

/**
 * Derive instantaneous watts from an entity. Precedence:
 *   1. an explicit power attribute (smart plugs / energy monitors expose
 *      current_power, power, wattage, …);
 *   2. a dedicated power sensor (device_class: power) whose STATE is the value,
 *      honoring a kW unit.
 * Returns null when no power signal is present (e.g. a plain on/off switch with
 * no metering) — the advisor then falls back to SHP2 circuit watts or the
 * operator's estimate.
 */
export function extractEntityWatts(e: { state: string; attributes: Record<string, unknown> }): number | null {
  const a = e.attributes ?? {};
  for (const k of ['current_power_w', 'current_power', 'power_w', 'power', 'wattage', 'active_power']) {
    const v = a[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  if (a.device_class === 'power') {
    const n = Number(e.state);
    if (Number.isFinite(n)) {
      const unit = String(a.unit_of_measurement ?? '').toUpperCase();
      return unit === 'KW' ? n * 1000 : n;
    }
  }
  return null;
}

/** Refetch all HA states if the cache is older than the TTL. Coalesces concurrent calls. */
export async function refreshIfStale(now: number = Date.now()): Promise<void> {
  if (now - lastFetchedAt < TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const states = await getAllStates();
      if (states) {
        const next = new Map<string, CachedEntity>();
        const ts = Date.now();
        for (const s of states) {
          next.set(s.entity_id, {
            entityId: s.entity_id,
            state: s.state,
            attributes: s.attributes ?? {},
            watts: extractEntityWatts(s),
            fetchedAt: ts,
          });
        }
        cache = next;
        lastFetchedAt = ts;
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedEntity(entityId: string): CachedEntity | null {
  return cache.get(entityId) ?? null;
}

export function getCachedStates(): ReadonlyMap<string, CachedEntity> {
  return cache;
}

export function getCacheAgeMs(now: number = Date.now()): number {
  return lastFetchedAt ? now - lastFetchedAt : Number.POSITIVE_INFINITY;
}

export function cacheSize(): number {
  return cache.size;
}

/** Test/reset hook. */
export function __resetHaStateCache(): void {
  cache = new Map();
  lastFetchedAt = 0;
  inflight = null;
}
