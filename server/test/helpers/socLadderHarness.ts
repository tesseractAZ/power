/**
 * v1.187.22 — a driver for the REAL SoC ladders (socLadders.ts startSocLadders): a store stand-in that
 * emits 'change' and 'hydrated' as SnapshotStore does, fake-serial device builders, and the ladders'
 * persisted state in a temp directory.
 *
 * TIME IS DETERMINISTIC. The ladders read an injected clock (`advanceClock`), and setTimeout — the
 * boot bound's timer — is a node:test mock timer (`advance` moves both). A real bound of a few tens
 * of milliseconds failed the 'inside the bound: withheld' assertions under parallel load (a GC pause
 * or a busy CPU between start and the first change opened the gate early). setImmediate stays real,
 * so settle() still drains a tick's async body.
 */
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSocLadders, type PoolGrid } from '../../src/socLadders.js';
import { BATTERY_SOC_THRESHOLDS } from '../../src/batterySocAlarm.js';
import type { FleetSnapshot } from '../../src/snapshot.js';
import type { AlarmPriority } from '../../src/alertPriority.js';

type Any = any;

/** SnapshotStore's event surface: 'change' on every write; markFirstPollSettled stamps, then 'hydrated'. */
export class FakeStore extends EventEmitter {
  firstPollSettledAt = 0;
  snap: FleetSnapshot = { generatedAt: 0, devices: {} };
  private readonly clock: () => number;
  constructor(clock: () => number) {
    super();
    this.clock = clock;
  }
  get(): FleetSnapshot { return this.snap; }
  change(devices: Record<string, Any>): void {
    this.snap = { generatedAt: this.clock(), devices };
    this.emit('change', this.snap);
  }
  hydrate(devices?: Record<string, Any>): void {
    if (devices) this.snap = { generatedAt: this.clock(), devices };
    this.firstPollSettledAt = this.clock();
    this.emit('hydrated', this.snap);
  }
}

// Fake serials only.
export const HOUSE = 'ZTESTHOUSE01';
export const GARAGE = 'ATESTGARAGE1';
export const C1 = 'TESTCORE0001';
export const C2 = 'TESTCORE0002';
export const C5 = 'TESTCORE0005';
export const C9 = 'TESTCORE0009';

/** A panel; `soc` undefined = no projection yet (its quota has not answered). */
export function panel(sn: string, name: string, cores: string[], soc?: number | null): Any {
  return {
    sn, deviceName: name, productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    ...(sn === HOUSE ? { housePanel: true } : {}),
    ...(soc === undefined ? { lastRoster: cores } : {
      projection: { kind: 'shp2', backupBatPercent: soc, sources: cores.map((c, i) => ({ slot: i + 1, sn: c, isConnected: true })) },
    }),
  };
}
/** A Core listed online; `soc` undefined = no projection yet. */
export function core(sn: string, soc?: number): Any {
  return {
    sn, deviceName: sn, productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    ...(soc === undefined ? {} : { projection: { kind: 'dpu', soc } }),
  };
}
/** The one-panel house: Cores 1, 2 and 5. */
export const house = (soc?: number | null) => panel(HOUSE, 'House Panel', [C1, C2, C5], soc);

/** Two pools: the house panel (Core 1) and a garage panel (Core 9). */
export function twoPanels(garageSoc: number | undefined, houseSoc = 60): Record<string, Any> {
  return {
    [HOUSE]: panel(HOUSE, 'House Panel', [C1], houseSoc),
    [GARAGE]: panel(GARAGE, 'Garage Panel', [C9], garageSoc),
    [C1]: core(C1, houseSoc),
    [C9]: core(C9),
  };
}

/** A ladder's state file as batterySocAlarm persists it: every rung below `soc` armed, a fresh baseline. */
export function persistedAt(soc: number, armedOverride?: Record<number, boolean>): object {
  const armed: Record<string, boolean> = {};
  for (const t of BATTERY_SOC_THRESHOLDS) armed[t.pct] = armedOverride?.[t.pct] ?? soc > t.pct;
  return { armed, lastSoc: soc, lastSocAtMs: Date.now() - 60_000 };
}

/** Lets a tick's async body (an awaited grid refresh, then the synchronous feeds) run to the end. */
export const settle = () => new Promise<void>((r) => setImmediate(r));

export interface SocLadderHarnessOptions {
  houseState?: object;
  panelStates?: Record<string, object>;
  /** The boot bound. Omitted ⇒ NOT passed, so startSocLadders applies its own default — as index.ts does. */
  maxMs?: number;
  roster?: string[];
  /** Each pool's grid verdict, by panel serial; read at call time, so a test may flip it between ticks. */
  grid?: (sn: string | undefined) => PoolGrid;
  isPriorityEnabled?: (p: AlarmPriority) => boolean;
  enabled?: boolean;
  /** Start with the store already hydrated (the steady state after boot). */
  hydrated?: boolean;
}

/** Builds the ladders over a FakeStore; mock timers and the cleanup are scoped to the test `t`. */
export function socLadderHarness(t: TestContext, o: SocLadderHarnessOptions = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clockMs = 1_000_000;
  const now = () => clockMs;
  const dir = mkdtempSync(join(tmpdir(), 'soc-ladders-'));
  const housePath = join(dir, 'house.json');
  const panelPath = (sn: string) => join(dir, `panel-${sn}.json`);
  if (o.houseState) writeFileSync(housePath, JSON.stringify(o.houseState));
  for (const [sn, st] of Object.entries(o.panelStates ?? {})) writeFileSync(panelPath(sn), JSON.stringify(st));
  const store = new FakeStore(now);
  if (o.hydrated) store.firstPollSettledAt = now();
  const announced: Array<{ priority: AlarmPriority; message: string }> = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const calls = { poolGrid: 0, refreshGrid: 0, noted: 0 };
  // index.ts's durable roster, seeded from the persisted membership fingerprint.
  let roster: ReadonlySet<string> = new Set(o.roster ?? [C1, C2, C5]);
  const ladders = startSocLadders(store, {
    enabled: o.enabled ?? true,
    announce: async (priority, message) => { announced.push({ priority, message }); return { ok: true }; },
    isPriorityEnabled: o.isPriorityEnabled ?? (() => true),
    refreshGrid: async () => { calls.refreshGrid++; },
    poolGrid: (_d, sn) => { calls.poolGrid++; return o.grid?.(sn) ?? { backstopping: false }; },
    noteLiveRoster: (r) => { calls.noted++; if (r.size > 0) roster = new Set(r); },
    lastKnownRoster: () => roster,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    ...(o.maxMs !== undefined ? { bootHydrationMaxMs: o.maxMs } : {}),
    now,
    houseStatePath: housePath,
    panelStatePathFor: panelPath,
  });
  t.after(() => { ladders.stop(); rmSync(dir, { recursive: true, force: true }); });
  return {
    store, announced, logs, warns, calls, ladders,
    messages: () => announced.map((a) => a.message),
    /** Time passes: the clock moves and any due timer (the boot bound) fires. */
    advance: (ms: number) => { clockMs += ms; t.mock.timers.tick(ms); },
    /** Only the clock moves — a timer held back by a blocked event loop. */
    advanceClock: (ms: number) => { clockMs += ms; },
  };
}
