/**
 * v1.6.0 — host power self-monitor.
 *
 * The alarm's own host (the Raspberry Pi) is the single point of failure for
 * the whole monitor: if it loses power, every channel goes dark at once. HA's
 * "Raspberry Pi Power Supply Checker" exposes the kernel under-voltage flag as
 * a binary_sensor with device_class 'problem' (on = under-voltage / throttling
 * detected, off = OK). A marginal or failing supply — or a sagging power
 * circuit — trips it BEFORE the Pi actually browns out, so surfacing it as an
 * alert is an early warning to fix the supply while the alarm is still up.
 *
 * Ingestion mirrors gridState.ts: the entity id comes from HOST_POWER_ENTITY
 * and the value is read from the shared HA state cache (haStateCache), which
 * index.ts's alert loop keeps warm whenever a host/grid entity is configured.
 * Best-effort throughout — an unset entity or a stale cache reads as unknown,
 * never as a false alarm.
 */
import * as haStateCache from './haStateCache.js';

/** 2 min — comfortably above the ~30 s cache TTL; beyond this the read is stale
 *  and we report unknown rather than replay a frozen last value. */
export const HOST_POWER_MAX_AGE_MS = 120_000;

/** Configured host-power binary_sensor entity id (empty = feature dormant). */
export function hostPowerEntityId(): string {
  return (process.env.HOST_POWER_ENTITY ?? '').trim();
}

export interface HostPowerHealth {
  configured: boolean;
  entityId: string;
  /** true = under-voltage/problem present; false = OK; null = unset/unknown/stale. */
  underVoltage: boolean | null;
  stale: boolean;
}

/** Interpret a cached binary_sensor (device_class = problem): on → true,
 *  off → false, anything else (unavailable/unknown) → null. Pure + exported
 *  for tests. */
export function interpretHostPowerEntity(e: { state: string } | null): boolean | null {
  if (!e) return null;
  const s = String(e.state).toLowerCase();
  if (s === 'on' || s === 'true' || s === 'problem') return true;
  if (s === 'off' || s === 'false' || s === 'ok') return false;
  return null;
}

/** Live wrapper: reads HOST_POWER_ENTITY from env + the HA state cache. */
export function liveHostPower(now: number = Date.now()): HostPowerHealth {
  const entityId = hostPowerEntityId();
  if (!entityId) return { configured: false, entityId: '', underVoltage: null, stale: false };
  const stale = haStateCache.getCacheAgeMs(now) > HOST_POWER_MAX_AGE_MS;
  if (stale) return { configured: true, entityId, underVoltage: null, stale: true };
  return {
    configured: true,
    entityId,
    underVoltage: interpretHostPowerEntity(haStateCache.getCachedEntity(entityId)),
    stale: false,
  };
}
