/**
 * v0.52.0 — fleet-membership selectors extracted from analytics.ts, where the
 * exact same two filters were inlined at ~25 call sites.
 *
 * Both are VERBATIM copies of the inlined expressions:
 *   - allDpus(devices)          === Object.values(devices).filter((d) => d.projection?.kind === 'dpu') as Array<...>
 *   - homeConnectedDpus(dpus, c) === dpus.filter((d) => isShp2Connected(d.sn, c))
 *
 * homeConnectedDpus takes the already-computed `dpus` array + `connected` Set so
 * a call site that ALSO needs the full DPU array does not recompute it. The
 * `.online`-filtered and `list`-based variants in analytics.ts are a DIFFERENT
 * predicate and are intentionally NOT routed through these.
 */

import type { DeviceSnapshot } from '../snapshot.js';
import type { DpuProjection } from '../ecoflow/project.js';
import { isShp2Connected } from '../shp2Membership.js';

export function allDpus(
  devices: Record<string, DeviceSnapshot>,
): Array<DeviceSnapshot & { projection: DpuProjection }> {
  return Object.values(devices).filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;
}

export function homeConnectedDpus(
  dpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
  connected: Set<string>,
): Array<DeviceSnapshot & { projection: DpuProjection }> {
  return dpus.filter((d) => isShp2Connected(d.sn, connected));
}
