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
import { isShp2Connected, allShp2s, shp2ConnectedDpuSns } from '../shp2Membership.js';

export function allDpus(
  devices: Record<string, DeviceSnapshot>,
): Array<DeviceSnapshot & { projection: DpuProjection }> {
  return Object.values(devices).filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;
}

/**
 * v1.187.18 — the device basis every analytics-worker report is computed on: the projected Cores,
 * the projected panels, and the Cores the panels list as connected sources, each sorted, as
 * `dpus|panels|home`. The worker's report chokepoint (reports.ts buildReport) resets its result
 * caches when an element ARRIVES in it, and single-flights each report per basis, so a report
 * built on the boot-time partial map (one bench Core projected, the panel not yet) is not served
 * on the hydrated map for its whole TTL (2026-10-11: degradation 4 packs of 24 for 30 min).
 *
 * Pack numbers are deliberately absent: a pack hidden or restored by one payload would otherwise
 * reset every cache. The degradation report keys its own cache on packs (degradationBasis).
 * Projections survive a cloud-offline transition verbatim (setDeviceList), so a Core going dark
 * does not move the key; only the panel's source list can flicker, and the chokepoint bounds that.
 */
export function reportBasisKey(devices: Record<string, DeviceSnapshot>): string {
  const dpus = allDpus(devices).map((d) => d.sn).sort();
  const panels = allShp2s(devices).map((d) => d.sn).sort();
  const home = [...shp2ConnectedDpuSns(devices)].sort();
  return `${dpus.join(',')}|${panels.join(',')}|${home.join(',')}`;
}

export function homeConnectedDpus(
  dpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
  connected: Set<string>,
): Array<DeviceSnapshot & { projection: DpuProjection }> {
  return dpus.filter((d) => isShp2Connected(d.sn, connected));
}
