/**
 * v1.187.22 — the SoC ladders wait for a HYDRATED store (bounded) before reading the device map.
 *
 * INCIDENT 2026-10-12 (host reboot, add-on start 22:04). The first store tick after boot carried
 * the device list and ONE roster Core's quota (49 %); the panel's pool % and the other two Cores
 * (56 %, 51 %) landed milliseconds later, and the real pool was 52 %. The SHP2-blind fallback averaged
 * the one Core, the armed 50 % rung fired ("crossed 50% (low) — SoC 49.0%"), and the announce was
 * spoken at 22:06:33 — then the real crossing at 22:26 was spoken again.
 *
 * These cases drive the REAL ladders and tick (socLadders.ts startSocLadders) through a store stand-in
 * that emits 'change' and 'hydrated' as SnapshotStore does, with persisted ladder state on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSocLadders, type PoolGrid } from '../src/socLadders.js';
import { socLadderBootGate, socAlarmMessage, BATTERY_SOC_THRESHOLDS } from '../src/batterySocAlarm.js';
import { BOOT_HYDRATION_MAX_MS } from '../src/alertMonitor.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { AlarmPriority } from '../src/alertPriority.js';

type Any = any;

/** SnapshotStore's event surface: 'change' on every write; markFirstPollSettled stamps, then 'hydrated'. */
class FakeStore extends EventEmitter {
  firstPollSettledAt = 0;
  snap: FleetSnapshot = { generatedAt: 0, devices: {} };
  get(): FleetSnapshot { return this.snap; }
  change(devices: Record<string, Any>): void {
    this.snap = { generatedAt: Date.now(), devices };
    this.emit('change', this.snap);
  }
  hydrate(devices?: Record<string, Any>): void {
    if (devices) this.snap = { generatedAt: Date.now(), devices };
    this.firstPollSettledAt = Date.now();
    this.emit('hydrated', this.snap);
  }
}

// Fake serials only.
const HOUSE = 'ZTESTHOUSE01';
const GARAGE = 'ATESTGARAGE1';
const C1 = 'TESTCORE0001';
const C2 = 'TESTCORE0002';
const C5 = 'TESTCORE0005';
const C9 = 'TESTCORE0009';

/** A panel; `soc` undefined = no projection yet (its quota has not answered). */
function panel(sn: string, name: string, cores: string[], soc?: number | null): Any {
  return {
    sn, deviceName: name, productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    ...(sn === HOUSE ? { housePanel: true } : {}),
    ...(soc === undefined ? { lastRoster: cores } : {
      projection: { kind: 'shp2', backupBatPercent: soc, sources: cores.map((c, i) => ({ slot: i + 1, sn: c, isConnected: true })) },
    }),
  };
}
/** A Core listed online; `soc` undefined = no projection yet. */
function core(sn: string, soc?: number): Any {
  return {
    sn, deviceName: sn, productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    ...(soc === undefined ? {} : { projection: { kind: 'dpu', soc } }),
  };
}
const house = (soc?: number | null) => panel(HOUSE, 'House Panel', [C1, C2, C5], soc);

/** A ladder's state file as batterySocAlarm persists it: every rung below `soc` armed, a fresh baseline. */
function persistedAt(soc: number, armedOverride?: Record<number, boolean>): object {
  const armed: Record<string, boolean> = {};
  for (const t of BATTERY_SOC_THRESHOLDS) armed[t.pct] = armedOverride?.[t.pct] ?? soc > t.pct;
  return { armed, lastSoc: soc, lastSocAtMs: Date.now() - 60_000 };
}

function harness(o: {
  houseState?: object;
  panelStates?: Record<string, object>;
  maxMs?: number;
  now?: () => number;
  roster?: string[];
  grid?: (sn: string | undefined) => PoolGrid;
  enabled?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'soc-boot-'));
  const housePath = join(dir, 'house.json');
  const panelPath = (sn: string) => join(dir, `panel-${sn}.json`);
  if (o.houseState) writeFileSync(housePath, JSON.stringify(o.houseState));
  for (const [sn, st] of Object.entries(o.panelStates ?? {})) writeFileSync(panelPath(sn), JSON.stringify(st));
  const store = new FakeStore();
  const announced: Array<{ priority: AlarmPriority; message: string }> = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const calls = { poolGrid: 0, refreshGrid: 0, noted: 0 };
  // index.ts's durable roster, seeded from the persisted membership fingerprint.
  let roster: ReadonlySet<string> = new Set(o.roster ?? [C1, C2, C5]);
  const ladders = startSocLadders(store, {
    enabled: o.enabled ?? true,
    announce: async (priority, message) => { announced.push({ priority, message }); return { ok: true }; },
    isPriorityEnabled: () => true,
    refreshGrid: async () => { calls.refreshGrid++; },
    poolGrid: (_d, sn) => { calls.poolGrid++; return o.grid?.(sn) ?? { backstopping: false }; },
    noteLiveRoster: (r) => { calls.noted++; if (r.size > 0) roster = new Set(r); },
    lastKnownRoster: () => roster,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    bootHydrationMaxMs: o.maxMs ?? 60_000,
    now: o.now,
    houseStatePath: housePath,
    panelStatePathFor: panelPath,
  });
  return {
    store, announced, logs, warns, calls, ladders,
    messages: () => announced.map((a) => a.message),
    cleanup: () => { ladders.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Lets a tick's async body (an awaited grid refresh, then the synchronous feeds) run to the end. */
const settle = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FIFTY = socAlarmMessage({ pct: 50, priority: 'low' });

// ── the pure gate ────────────────────────────────────────────────────────────

test('socLadderBootGate: withhold before hydration, open on hydration, open at the bound', () => {
  assert.equal(socLadderBootGate({ firstPollSettledAt: 0, elapsedMs: 0, maxMs: 30_000 }), 'withhold');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 0, elapsedMs: 29_999, maxMs: 30_000 }), 'withhold');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 0, elapsedMs: 30_000, maxMs: 30_000 }), 'bound', 'the bound is inclusive');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 0, elapsedMs: 3_600_000, maxMs: 30_000 }), 'bound', 'a cloud outage at boot never holds the ladders for good');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 1, elapsedMs: 0, maxMs: 30_000 }), 'hydrated');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 1, elapsedMs: 90_000, maxMs: 30_000 }), 'hydrated', 'hydration names the opening even past the bound');
  assert.equal(socLadderBootGate({ firstPollSettledAt: 0, elapsedMs: 0, maxMs: 0 }), 'bound', 'a zero bound disables the wait');
  assert.equal(BOOT_HYDRATION_MAX_MS, 30_000, 'the ladders share the alert monitor\'s bound');
});

// ── the incident, through the real tick ──────────────────────────────────────

test('★★★ THE 2026-10-12 22:04:09 REPLAY — a one-Core boot mean is never fed; the real crossing is spoken once', async () => {
  const h = harness({ houseState: persistedAt(52) });
  try {
    // 22:04:09 — the device list has landed; only Core 5's quota has answered; the panel has no projection.
    h.store.change({ [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) });
    await settle();
    assert.deepEqual(h.messages(), [], 'no 50 % rung from a one-Core mean (the false 22:06:33 announce)');
    // milliseconds later — Cores 1 and 2; then the panel's own pool %; the poll has not settled yet.
    h.store.change({ [HOUSE]: house(), [C1]: core(C1, 56), [C2]: core(C2, 51), [C5]: core(C5, 49) });
    await settle();
    const hydrated = { [HOUSE]: house(52), [C1]: core(C1, 56), [C2]: core(C2, 51), [C5]: core(C5, 49) };
    h.store.change(hydrated);
    await settle();
    assert.deepEqual(h.messages(), []);
    assert.equal(h.calls.poolGrid + h.calls.refreshGrid, 0, 'no ladder tick ran — house, secondary ladders and re-escalation alike');
    assert.equal(h.calls.noted, 3, 'the live roster is still noted on a withheld tick (not a ladder feed)');
    const withheld = h.logs.filter((l) => l.includes('withholding the SoC ladders'));
    assert.equal(withheld.length, 1, 'one line for the withheld ticks, not one per tick');
    assert.match(withheld[0], /the fallback would read 49\.0% from 1 of 3 roster Cores/);
    // the first poll settles: the hydrated 52 % crosses nothing
    h.store.hydrate();
    await settle();
    assert.deepEqual(h.messages(), []);
    const opened = h.logs.filter((l) => l.includes('the first poll settled'));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\(3 tick\(s\) withheld\)/);
    assert.equal(h.warns.length, 0);
    // 22:26 — the real crossing, once
    h.store.change({ ...hydrated, [HOUSE]: house(50) });
    await settle();
    h.store.change({ ...hydrated, [HOUSE]: house(49.5) });
    await settle();
    assert.deepEqual(h.messages(), [FIFTY], 'exactly one 50 % announcement');
    assert.equal(h.logs.filter((l) => l.includes('the first poll settled') || l.includes('withholding')).length, 2, 'no further gate lines');
  } finally {
    h.cleanup();
  }
});

test('★★ the first hydrated value is evaluated on the \'hydrated\' event itself, and never twice', async () => {
  const h = harness({ houseState: persistedAt(52) });
  try {
    h.store.change({ [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) });
    await settle();
    // The last quota's change precedes markFirstPollSettled, so it is withheld; the pool really is at 49.
    const real = { [HOUSE]: house(49), [C1]: core(C1, 49), [C2]: core(C2, 50), [C5]: core(C5, 49) };
    h.store.change(real);
    await settle();
    assert.deepEqual(h.messages(), []);
    h.store.hydrate();
    await settle();
    assert.deepEqual(h.messages(), [FIFTY], 'announced on hydration, without waiting for the next change');
    h.store.change(real);
    await settle();
    h.store.change(real);
    await settle();
    assert.deepEqual(h.messages(), [FIFTY], 'the next changes feed the same value: no second announce');
  } finally {
    h.cleanup();
  }
});

// ── the bound ────────────────────────────────────────────────────────────────

test('★★★ never hydrated: at the bound the fallback feeds exactly as before (a timer, no change needed)', async () => {
  const h = harness({ houseState: persistedAt(52), maxMs: 60 });
  try {
    const partial = { [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) };
    h.store.change(partial);
    await settle();
    assert.deepEqual(h.messages(), [], 'inside the bound: withheld');
    await sleep(150);
    assert.deepEqual(h.messages(), [FIFTY], 'past the bound the one-Core mean is fed, as before the gate');
    assert.equal(h.warns.filter((w) => w.includes('no complete poll within')).length, 1);
    h.store.change(partial);
    await settle();
    h.store.hydrate();
    await settle();
    assert.deepEqual(h.messages(), [FIFTY], 'no second announce after the bound opened');
    assert.equal(h.warns.length, 1, 'one opening line');
  } finally {
    h.cleanup();
  }
});

test('★★ never hydrated: a change past the bound is fed (the tick reads the clock, not only the timer)', async () => {
  let clock = 1_000_000;
  const h = harness({ houseState: persistedAt(52), maxMs: 30_000, now: () => clock });
  try {
    const partial = { [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) };
    h.store.change(partial);
    await settle();
    clock += 29_999;
    h.store.change(partial);
    await settle();
    assert.deepEqual(h.messages(), []);
    clock += 1;
    h.store.change(partial);
    await settle();
    assert.deepEqual(h.messages(), [FIFTY]);
    assert.match(h.warns[0] ?? '', /no complete poll within 30 s of start; the SoC ladders read the data that exists \(2 tick\(s\) withheld\)/);
  } finally {
    h.cleanup();
  }
});

test('the store already hydrated at start: the first change is fed at once', async () => {
  const h = harness({ houseState: persistedAt(52) });
  try {
    h.store.firstPollSettledAt = Date.now();
    h.store.change({ [HOUSE]: house(49), [C1]: core(C1, 49), [C2]: core(C2, 49), [C5]: core(C5, 49) });
    await settle();
    assert.deepEqual(h.messages(), [FIFTY]);
    assert.equal(h.logs.filter((l) => l.includes('withholding')).length, 0);
  } finally {
    h.cleanup();
  }
});

test('BATTERY_SOC_ALARM_ENABLED=false: nothing is fed, before or after the bound', async () => {
  const h = harness({ houseState: persistedAt(52), maxMs: 20, enabled: false });
  try {
    h.store.change({ [HOUSE]: house(49), [C1]: core(C1, 49), [C2]: core(C2, 49), [C5]: core(C5, 49) });
    await sleep(60);
    h.store.hydrate();
    await settle();
    assert.deepEqual(h.messages(), []);
    assert.deepEqual([...h.logs, ...h.warns], []);
  } finally {
    h.cleanup();
  }
});

// ── secondary panels ─────────────────────────────────────────────────────────

function twoPanels(garageSoc: number | undefined): Record<string, Any> {
  return {
    [HOUSE]: panel(HOUSE, 'House Panel', [C1], 60),
    [GARAGE]: panel(GARAGE, 'Garage Panel', [C9], garageSoc),
    [C1]: core(C1, 60),
    [C9]: core(C9),
  };
}
const GARAGE_FIFTY = socAlarmMessage({ pct: 50, priority: 'low' }, 'Garage Panel');

test('★★★ a SECONDARY panel\'s ladder is gated too: nothing before hydration, its real crossing once after', async () => {
  const h = harness({ panelStates: { [GARAGE]: persistedAt(52) }, roster: [C1] });
  try {
    h.store.change(twoPanels(49)); // a pre-hydration reading of the garage pool
    await settle();
    assert.deepEqual(h.messages(), []);
    assert.match(h.logs.find((l) => l.includes('withholding')) ?? '', /1 other panel ladder\(s\) held too/);
    h.store.hydrate(twoPanels(52));
    await settle();
    assert.deepEqual(h.messages(), [], 'the hydrated 52 % crosses nothing');
    h.store.change(twoPanels(50));
    await settle();
    h.store.change(twoPanels(49));
    await settle();
    assert.deepEqual(h.messages(), [GARAGE_FIFTY]);
  } finally {
    h.cleanup();
  }
});

test('★★★ a SECONDARY panel\'s ladder opens at the bound like the house ladder', async () => {
  const h = harness({ panelStates: { [GARAGE]: persistedAt(52) }, roster: [C1], maxMs: 60 });
  try {
    h.store.change(twoPanels(49));
    await settle();
    assert.deepEqual(h.messages(), []);
    await sleep(150);
    assert.deepEqual(h.messages(), [GARAGE_FIFTY], 'past the bound the garage pool is fed what exists');
  } finally {
    h.cleanup();
  }
});

// ── the grid-drop re-escalation pass ─────────────────────────────────────────

test('★★★ the grid-drop re-escalation pass is behind the gate: no re-escalation from a partial map', async () => {
  // A grid-downgraded 10 % rung held while the gate is closed. The record lives in memory and only a
  // fed crossing writes it, so at boot it is empty; the seed stands for any record the pass could
  // hold, so the pass itself is shown to sit behind the gate (a pass ahead of it would re-escalate
  // here from the one-Core 9 % mean).
  const h = harness({ houseState: persistedAt(9, { 50: false, 40: false, 30: false, 20: false, 15: false, 10: false }) });
  try {
    h.ladders.houseDowngraded.set(10, 'critical');
    h.store.change({ [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 9) });
    await settle();
    assert.deepEqual(h.announced, [], 'withheld: no re-escalation');
    assert.deepEqual([...h.ladders.houseDowngraded.keys()], [10], 'the record is untouched');
    h.store.hydrate({ [HOUSE]: house(9), [C1]: core(C1, 9), [C2]: core(C2, 9), [C5]: core(C5, 9) });
    await settle();
    assert.deepEqual(h.announced, [{ priority: 'critical', message: socAlarmMessage({ pct: 10, priority: 'critical' }) }],
      'hydrated, off-grid, still under 10 %: the downgraded rung re-escalates once');
    h.store.change({ [HOUSE]: house(9), [C1]: core(C1, 9), [C2]: core(C2, 9), [C5]: core(C5, 9) });
    await settle();
    assert.equal(h.announced.length, 1);
  } finally {
    h.cleanup();
  }
});

// ── index.ts wiring ──────────────────────────────────────────────────────────

test('index.ts feeds the ladders only through startSocLadders (no second, ungated store handler)', () => {
  const idx = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.match(idx, /const socLadders = startSocLadders\(store, \{\n  enabled: socAlarmEnabled,/);
  assert.match(idx, /  poolGrid: livePoolGridBackstop,\n  noteLiveRoster,\n  lastKnownRoster: \(\) => lastKnownRoster,/);
  assert.doesNotMatch(idx, /createBatterySocAlarm|reEscalateGridDrop|housePoolFallbackSoc/, 'the ladders, the re-escalation pass and the fallback read live in socLadders.ts');
  assert.match(idx, /  socLadders\.stop\(\);/);
});
