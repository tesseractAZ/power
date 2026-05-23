import type { DeviceSnapshot } from './types';

/**
 * Extract a trailing integer from a device name ("Core 5" → 5) for numeric sort.
 * Returns null when there's no trailing number.
 */
function trailingNum(name: string): number | null {
  const m = name.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Canonical device ordering for the whole UI:
 *   0. Smart Home Panel(s)
 *   1. Delta Pro Ultra "Core N" — sorted numerically (Core 1, 2, … 10, 11)
 *   2. Delta 3 Plus units — grouped together
 *   3. Everything else — alphabetical
 */
export function compareDevices(a: DeviceSnapshot, b: DeviceSnapshot): number {
  const rank = (d: DeviceSnapshot): number => {
    const p = (d.productName ?? '').toLowerCase();
    if (p.includes('smart home panel')) return 0;
    if (p.includes('delta pro ultra')) return 1;
    if (p.includes('delta 3 plus')) return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    // Both DPUs — sort by trailing number ("Core N"), nulls last
    const na = trailingNum(a.deviceName);
    const nb = trailingNum(b.deviceName);
    if (na != null && nb != null) return na - nb;
    if (na != null) return -1;
    if (nb != null) return 1;
  }
  return a.deviceName.localeCompare(b.deviceName);
}

/** Sort a device list with the canonical ordering (non-mutating). */
export function sortDevices(devices: DeviceSnapshot[]): DeviceSnapshot[] {
  return [...devices].sort(compareDevices);
}
