/**
 * todayBridgeFixtures.ts — normal days for the Today card's totals (aggregator.computeTotals), for
 * todayBridge.test.ts: three home Cores reporting on their own meters all day, a bench spare that
 * is not on the panel, and the Smart Home Panel 2.
 *
 * Every series is deterministic (a seeded generator per series), sampled once a minute with the odd
 * gap, so the same cases can be run through computeTotals as it stood before v1.190.2 to produce
 * the golden output (todayBridge.golden.json) and through computeTotals as it stands now. On such a
 * day the energy bridge books nothing, so every figure must be the one it was, byte for byte.
 * Test serials are placeholders.
 */
import type { DeviceSnapshot, SnapshotStore } from '../../src/snapshot.js';

const MIN = 60_000;
const H = 60 * MIN;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
export const phx = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h + 7, mi);

export const GOLDEN_PANEL = 'HD31XXX00XXX0011';
export const GOLDEN_CORES = ['Y711XXX00XXX0011', 'Y711XXX00XXX0012', 'Y711XXX00XXX0013'];
export const GOLDEN_SPARE = 'Y711XXX00XXX0014';
const PACKS = 2;

/** mulberry32 — a small deterministic generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function core(sn: string): DeviceSnapshot {
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 0,
    projection: {
      kind: 'dpu', soc: 60, packCount: PACKS, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, acOutWatts: 0,
      packs: Array.from({ length: PACKS }, (_, i) => ({ num: i + 1, packSn: `${sn}-P${i + 1}`, soc: 60, inputWatts: 0, outputWatts: 0 })),
    },
  } as unknown as DeviceSnapshot;
}

export function goldenDevices(): Record<string, DeviceSnapshot> {
  const panel = {
    sn: GOLDEN_PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: 0,
    projection: {
      kind: 'shp2', circuits: [], pairedCircuits: [], sourceWatts: [-800, -800, -800],
      sources: GOLDEN_CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, batteryPercentage: 60, fullCap: 30_720, pvWatts: 0 })),
    },
  } as unknown as DeviceSnapshot;
  const out: Record<string, DeviceSnapshot> = { [GOLDEN_PANEL]: panel };
  for (const sn of GOLDEN_CORES) out[sn] = core(sn);
  out[GOLDEN_SPARE] = core(GOLDEN_SPARE);
  return out;
}

export function goldenStore(devices = goldenDevices()): SnapshotStore {
  return { get: () => ({ generatedAt: 0, devices }) } as unknown as SnapshotStore;
}

/** The sun on 2026-10-13 in Phoenix: up 06:30-18:00, peak `peakW` at 12:15. */
function solar(ts: number, dayStart: number, peakW: number): number {
  const h = (ts - dayStart) / H;
  if (h < 6.5 || h > 18) return 0;
  return peakW * Math.sin(Math.PI * (h - 6.5) / 11.5);
}

/** The recorded series of one device over [fromMs, toMs], one row a minute, keyed by metric. */
export function goldenSeries(fromMs: number, toMs: number): Map<string, Array<{ ts: number; value: number }>> {
  const dayStart = phx(2026, 10, 13, 0);
  const out = new Map<string, Array<{ ts: number; value: number }>>();
  const put = (sn: string, metric: string, ts: number, value: number): void => {
    const k = `${sn}|${metric}`;
    let a = out.get(k);
    if (!a) { a = []; out.set(k, a); }
    a.push({ ts, value });
  };
  const all = [...GOLDEN_CORES, GOLDEN_SPARE];
  const rand = new Map(all.map((sn) => [sn, rng(seedOf(sn))]));
  const panelRand = rng(seedOf(GOLDEN_PANEL));
  for (let ts = fromMs; ts <= toMs; ts += MIN) {
    all.forEach((sn, i) => {
      const r = rand.get(sn)!;
      const jitter = r();
      // Core 2 drops its rows for 25 min mid-morning (a cloud stall), the spare after 15:00.
      const gap = (sn === GOLDEN_CORES[1] && ts >= dayStart + 9 * H && ts < dayStart + 9 * H + 25 * MIN)
        || (sn === GOLDEN_SPARE && ts >= dayStart + 15 * H);
      if (gap) return;
      const pv = sn === GOLDEN_SPARE ? solar(ts, dayStart, 900) * (0.9 + 0.2 * jitter) : solar(ts, dayStart, 3200 + 300 * i) * (0.85 + 0.3 * jitter);
      const acOut = 700 + 400 * r() + (ts - dayStart > 17 * H ? 600 : 0);
      const bat = acOut + 40 - pv; // + = discharging
      put(sn, 'pv_total', ts, pv);
      put(sn, 'ac_out', ts, acOut);
      put(sn, 'total_in', ts, pv);
      put(sn, 'total_out', ts, acOut);
      for (let n = 1; n <= PACKS; n++) {
        put(sn, `pack${n}_out`, ts, Math.max(0, bat) / PACKS);
        put(sn, `pack${n}_in`, ts, Math.max(0, -bat) / PACKS);
      }
    });
    put(GOLDEN_PANEL, 'panel_load', ts, 2300 + 900 * panelRand());
  }
  return out;
}

/** The windows the golden pins: a whole day, "today" at 13:47, an hour, and a zero-width window. */
export function goldenWindows(): Array<{ label: string; sinceMs: number; untilMs: number }> {
  const d = phx(2026, 10, 13, 0);
  return [
    { label: 'whole day', sinceMs: d, untilMs: d + 24 * H },
    { label: 'today at 13:47', sinceMs: d, untilMs: d + 13 * H + 47 * MIN + 12_345 },
    { label: 'one hour', sinceMs: d + 10 * H, untilMs: d + 11 * H },
    { label: 'zero width', sinceMs: d + 12 * H, untilMs: d + 12 * H },
  ];
}

/** The series the cases read: the day before through the day after. */
export function goldenRows(): Map<string, Array<{ ts: number; value: number }>> {
  const d = phx(2026, 10, 13, 0);
  return goldenSeries(d - 2 * H, d + 26 * H);
}
