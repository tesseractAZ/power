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
 * that emits 'change' and 'hydrated' as SnapshotStore does, with persisted ladder state on disk
 * (test/helpers/socLadderHarness.ts). Time is an injected clock and a mock setTimeout, so no case
 * depends on how fast it runs; the bound is startSocLadders's own default unless a case names one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { socLadderBootGate, socAlarmMessage } from '../src/batterySocAlarm.js';
import { BOOT_HYDRATION_MAX_MS } from '../src/alertMonitor.js';
import {
  socLadderHarness as harness, settle, persistedAt, core, house, twoPanels, HOUSE, C1, C2, C5, GARAGE,
} from './helpers/socLadderHarness.js';

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

test('★★★ THE 2026-10-12 22:04:09 REPLAY — a one-Core boot mean is never fed; the real crossing is spoken once', async (t) => {
  const h = harness(t, { houseState: persistedAt(52) });
  // 22:04:09 — the device list has landed; only Core 5's quota has answered; the panel has no projection.
  h.store.change({ [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) });
  await settle();
  assert.deepEqual(h.messages(), [], 'no 50 % rung from a one-Core mean (the false 22:06:33 announce)');
  // milliseconds later — Cores 1 and 2; then the panel's own pool %; the poll has not settled yet.
  h.advance(40);
  h.store.change({ [HOUSE]: house(), [C1]: core(C1, 56), [C2]: core(C2, 51), [C5]: core(C5, 49) });
  await settle();
  const hydrated = { [HOUSE]: house(52), [C1]: core(C1, 56), [C2]: core(C2, 51), [C5]: core(C5, 49) };
  h.advance(1_200);
  h.store.change(hydrated);
  await settle();
  assert.deepEqual(h.messages(), []);
  assert.equal(h.calls.poolGrid + h.calls.refreshGrid, 0, 'no ladder tick ran — house, secondary ladders and re-escalation alike');
  assert.equal(h.calls.noted, 3, 'the live roster is still noted on a withheld tick (not a ladder feed)');
  const withheld = h.logs.filter((l) => l.includes('withholding the SoC ladders'));
  assert.equal(withheld.length, 1, 'one line for the withheld ticks, not one per tick');
  assert.match(withheld[0], /\(at most 30 s\) — the house pool's own figure is not hydrated; the fallback would read 49\.0% from 1 of 3 roster Cores$/);
  // the first poll settles: the hydrated 52 % crosses nothing
  h.advance(760);
  h.store.hydrate();
  await settle();
  assert.deepEqual(h.messages(), []);
  const opened = h.logs.filter((l) => l.includes('the first poll settled'));
  assert.equal(opened.length, 1);
  assert.match(opened[0], /settled 2000 ms after start .*\(3 tick\(s\) withheld\)/);
  assert.equal(h.warns.length, 0);
  // 22:26 — the real crossing, once
  h.store.change({ ...hydrated, [HOUSE]: house(50) });
  await settle();
  h.store.change({ ...hydrated, [HOUSE]: house(49.5) });
  await settle();
  assert.deepEqual(h.messages(), [FIFTY], 'exactly one 50 % announcement');
  assert.equal(h.logs.filter((l) => l.includes('the first poll settled') || l.includes('withholding')).length, 2, 'no further gate lines');
});

test('★★ the first hydrated value is evaluated on the \'hydrated\' event itself, and never twice', async (t) => {
  const h = harness(t, { houseState: persistedAt(52) });
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
});

// ── the bound ────────────────────────────────────────────────────────────────

const PARTIAL = () => ({ [HOUSE]: house(), [C1]: core(C1), [C2]: core(C2), [C5]: core(C5, 49) });

test('★★★ the PRODUCTION bound (none passed, as index.ts passes none): withheld at BOOT_HYDRATION_MAX_MS − 1, fed at BOOT_HYDRATION_MAX_MS', async (t) => {
  // A zero default disables the gate (the 22:04:09 announce is back); an unbounded one holds every
  // SoC ladder silent through a boot-time cloud outage. Both fail here.
  const h = harness(t, { houseState: persistedAt(52) });
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), [], 'at start: withheld');
  h.advance(BOOT_HYDRATION_MAX_MS - 1);
  await settle();
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), [], `${BOOT_HYDRATION_MAX_MS - 1} ms after start: still withheld`);
  h.advance(1);
  await settle();
  assert.deepEqual(h.messages(), [FIFTY], `the bound timer at ${BOOT_HYDRATION_MAX_MS} ms feeds what exists, with no further change`);
  assert.match(h.warns[0] ?? '', /no complete poll within 30 s of start; the SoC ladders read the data that exists \(2 tick\(s\) withheld\)/);
});

test('★★★ the PRODUCTION bound read from the clock: a change at BOOT_HYDRATION_MAX_MS is fed even if the timer is late', async (t) => {
  const h = harness(t, { houseState: persistedAt(52) });
  h.store.change(PARTIAL());
  await settle();
  h.advanceClock(BOOT_HYDRATION_MAX_MS - 1); // the timer held back by a blocked boot event loop
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), []);
  h.advanceClock(1);
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), [FIFTY]);
});

test('★★★ never hydrated: at a configured bound the fallback feeds exactly as before (a timer, no change needed)', async (t) => {
  const h = harness(t, { houseState: persistedAt(52), maxMs: 60 });
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), [], 'inside the bound: withheld');
  h.advance(59);
  await settle();
  assert.deepEqual(h.messages(), [], 'one millisecond short of the bound: withheld');
  h.advance(1);
  await settle();
  assert.deepEqual(h.messages(), [FIFTY], 'past the bound the one-Core mean is fed, as before the gate');
  assert.equal(h.warns.filter((w) => w.includes('no complete poll within')).length, 1);
  h.store.change(PARTIAL());
  await settle();
  h.store.hydrate();
  await settle();
  assert.deepEqual(h.messages(), [FIFTY], 'no second announce after the bound opened');
  assert.equal(h.warns.length, 1, 'one opening line');
});

test('★★ never hydrated: a change past the bound is fed (the tick reads the clock, not only the timer)', async (t) => {
  const h = harness(t, { houseState: persistedAt(52), maxMs: 30_000 });
  h.store.change(PARTIAL());
  await settle();
  h.advanceClock(29_999);
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), []);
  h.advanceClock(1);
  h.store.change(PARTIAL());
  await settle();
  assert.deepEqual(h.messages(), [FIFTY]);
  assert.match(h.warns[0] ?? '', /no complete poll within 30 s of start; the SoC ladders read the data that exists \(2 tick\(s\) withheld\)/);
});

test('the store already hydrated at start: the first change is fed at once', async (t) => {
  const h = harness(t, { houseState: persistedAt(52), hydrated: true });
  h.store.change({ [HOUSE]: house(49), [C1]: core(C1, 49), [C2]: core(C2, 49), [C5]: core(C5, 49) });
  await settle();
  assert.deepEqual(h.messages(), [FIFTY]);
  assert.equal(h.logs.filter((l) => l.includes('withholding')).length, 0);
});

test('BATTERY_SOC_ALARM_ENABLED=false: nothing is fed, before or after the bound', async (t) => {
  const h = harness(t, { houseState: persistedAt(52), maxMs: 20, enabled: false });
  h.store.change({ [HOUSE]: house(49), [C1]: core(C1, 49), [C2]: core(C2, 49), [C5]: core(C5, 49) });
  h.advance(60);
  await settle();
  h.store.hydrate();
  await settle();
  assert.deepEqual(h.messages(), []);
  assert.deepEqual([...h.logs, ...h.warns], []);
});

// ── secondary panels ─────────────────────────────────────────────────────────

const GARAGE_FIFTY = socAlarmMessage({ pct: 50, priority: 'low' }, 'Garage Panel');

test('★★★ a SECONDARY panel\'s ladder is gated too: nothing before hydration, its real crossing once after', async (t) => {
  const h = harness(t, { panelStates: { [GARAGE]: persistedAt(52) }, roster: [C1] });
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
});

test('★★★ a SECONDARY panel\'s ladder opens at the bound like the house ladder', async (t) => {
  const h = harness(t, { panelStates: { [GARAGE]: persistedAt(52) }, roster: [C1] });
  h.store.change(twoPanels(49));
  await settle();
  h.advance(BOOT_HYDRATION_MAX_MS - 1);
  await settle();
  assert.deepEqual(h.messages(), []);
  h.advance(1);
  await settle();
  assert.deepEqual(h.messages(), [GARAGE_FIFTY], 'past the bound the garage pool is fed what exists');
});

// ── the grid-drop re-escalation pass ─────────────────────────────────────────

test('★★★ the grid-drop re-escalation pass is behind the gate: no re-escalation from a partial map', async (t) => {
  // A grid-downgraded 10 % rung held while the gate is closed. The record lives in memory and only a
  // fed crossing writes it, so at boot it is empty; the seed stands for any record the pass could
  // hold, so the pass itself is shown to sit behind the gate (a pass ahead of it would re-escalate
  // here from the one-Core 9 % mean).
  const h = harness(t, { houseState: persistedAt(9, { 50: false, 40: false, 30: false, 20: false, 15: false, 10: false }) });
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
});

// ── index.ts wiring ──────────────────────────────────────────────────────────

// The WHOLE call, verbatim: index.ts's only link to the ladders. A dropped or silenced announce, the
// Alert Settings toggles replaced, the grid refresh removed, or a bound passed (bootHydrationMaxMs: 0
// disables the gate) each fail here; the behaviour behind every argument is driven above and in
// test/socLadders.test.ts.
const LADDERS_CALL = `const socLadders = startSocLadders(store, {
  enabled: socAlarmEnabled,
  announce: (priority, message, messageEs) => broadcast.announce(priority, message, messageEs),
  isPriorityEnabled,
  // Keep the grid-presence entity fresh (TTL-gated) so the tick's grid verdicts are live.
  refreshGrid: async () => {
    if (gridPresenceEntityId() || hostPowerEntityId()) await haStateCache.refreshIfStale();
  },
  poolGrid: livePoolGridBackstop,
  noteLiveRoster,
  lastKnownRoster: () => lastKnownRoster,
  log: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});`;

test('index.ts feeds the ladders only through startSocLadders, with exactly these arguments (no second, ungated store handler)', () => {
  const idx = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.equal(idx.split(LADDERS_CALL).length - 1, 1, 'the startSocLadders call, every argument as reviewed');
  assert.equal(idx.split('startSocLadders(').length - 1, 1, 'one set of ladders');
  assert.doesNotMatch(idx, /bootHydrationMaxMs/, 'the bound is startSocLadders\'s own default (BOOT_HYDRATION_MAX_MS)');
  assert.match(idx, /import \{ getAlertSettings, updateAlertSettings, isPriorityEnabled \} from '\.\/alertSettings\.js';/,
    'isPriorityEnabled is the Alert Settings annunciation toggle');
  assert.doesNotMatch(idx, /createBatterySocAlarm|reEscalateGridDrop|housePoolFallbackSoc/, 'the ladders, the re-escalation pass and the fallback read live in socLadders.ts');
  assert.match(idx, /  socLadders\.stop\(\);/);
});
