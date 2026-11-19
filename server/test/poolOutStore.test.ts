/**
 * v1.208.0 — the pool-out tracker WIRED INTO THE STORE (src/snapshot.ts): every REST body of a panel is folded through
 * poolOut.ts, with the body's own time, the raw map and the store's shadow latch; the state is persisted and restored;
 * the panel's own fields are logged when they change; the body is captured at a tracker event.
 *
 * A real SnapshotStore, no alert monitor (test/poolOutMonitor.test.ts has that). The bodies are the pool-out fixtures:
 * rows of the recorder's 5-minute panel series for 2026-11-14 and 2026-11-16 with the capacity, the flags and a MOVING
 * twelve-circuit vector ADDED by the builder (synthetic: none was recorded), and placeholder serials.
 *
 * The control tests at the top pass without this release: they show the fixture reaches the store as new, unlatched
 * bodies at the right capacity, so a red test below is about the wiring and not about the fixture.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Body, TimedBody } from './fixtures/poolOutFixtures.js';

const ROOT = mkdtempSync(join(tmpdir(), 'ef-pool-out-store-'));
process.env.DB_PATH = join(ROOT, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(ROOT, 'shadow-witness.json');
process.env.SITE_TIMEZONE = 'America/Phoenix';
delete process.env.SUPERVISOR_TOKEN;

const { SnapshotStore, POOL_OUT_PERSIST_EVERY_MS } = await import('../src/snapshot.js');
const { parsePoolOutFile, poolOutSeverity } = await import('../src/poolOut.js');
// Loaded inside the tests that need it: the module does not exist before this release, and the two control tests
// below must run (and pass) there.
const record = () => import('../src/poolOutRecord.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN, CORE_SNS, MIN, at, healthyBody, lostBody, quietBody } = fx;

type Store = InstanceType<typeof SnapshotStore>;
const OTHER_PANEL = 'HD31XXX00XXX0002';
const LOSS = fx.loadPoolFixture('pool-loss-1114');
const RETURN = fx.loadPoolFixture('pool-return-1116');
const lossBodies = fx.bodiesFromRows(LOSS.rows, (t) => fx.capacityAt(LOSS.capacity, t));
const returnBodies = fx.bodiesFromRows(RETURN.rows, (t) => fx.capacityAt(RETURN.capacity, t));
const iso = (s: string): number => Date.parse(s);
const listed = (...sns: string[]) => sns.map((sn) => ({ sn, deviceName: sn === PANEL_SN ? 'Smart Home Panel 2' : 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 })) as any[];

after(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
interface Rig { store: Store; lines: string[]; warns: string[]; clock: { ms: number }; file: string; events: string; feed: (atMs: number, body: Body, sn?: string) => void }
/** A store on its own files, its clock set by each body fed. `file` names an existing state file to restart on. */
function rig(opts: { file?: string; events?: string | null; panels?: string[]; noState?: boolean } = {}): Rig {
  const name = `s${++seq}`;
  const file = opts.file ?? join(ROOT, `${name}-pool-out.json`);
  const events = opts.events === undefined ? join(ROOT, `${name}-events`) : opts.events;
  const store = new SnapshotStore({ poolOutPath: opts.noState ? null : file, poolEventsDir: events });
  const clock = { ms: 0 };
  store.setClock(() => clock.ms);
  const lines: string[] = [];
  const warns: string[] = [];
  store.setLogger((m) => lines.push(m));
  store.setWarnLogger((m) => { warns.push(m); lines.push(m); });
  const panels = opts.panels ?? [PANEL_SN];
  store.setDeviceList(listed(...panels));
  return {
    store, lines, warns, clock, file, events: events ?? '',
    feed: (atMs, body, sn = PANEL_SN) => { clock.ms = atMs; store.setDeviceQuota(sn, body); },
  };
}
const pool = (lines: string[]): string[] => lines.filter((l) => /^pool-(out|diag)/.test(l));
const feedAll = (r: Rig, bodies: TimedBody[], until = Infinity): void => { for (const b of bodies) if (b.atMs <= until) r.feed(b.atMs, b.body); };

/* ══ controls: these pass without this release ═════════════════════════════════════════════════════ */

test('control ★ every fixture body reaches the store as NEW content with the shadow latch clear, at the capacity of its minute', () => {
  const r = rig({ noState: true, events: null });
  for (const b of [...lossBodies, ...returnBodies]) {
    r.feed(b.atMs, b.body);
    const d = r.store.get().devices[PANEL_SN] as any;
    assert.equal(d.contentNewAtMs, b.atMs, `${new Date(b.atMs).toISOString()}: the body is new (contentNewAtMs advanced)`);
    assert.equal(d.contentStaleSinceMs ?? null, null, `${new Date(b.atMs).toISOString()}: no stale-shadow latch`);
    const lossShort = b.atMs >= iso(LOSS.capacity.shortFromIso) && b.atMs < iso(RETURN.capacity.shortUntilIso);
    assert.equal(d.projection.backupFullCapWh, lossShort ? 61440 : 92160, new Date(b.atMs).toISOString());
  }
  assert.equal((r.store.get().devices[PANEL_SN] as any).projection.kind, 'shp2');
});

test('control ★ the same bodies with a FIXED circuit vector are one body and replays: the store latches a stale shadow (why the fixture moves)', () => {
  const r = rig({ noState: true, events: null });
  const frozen = lossBodies.slice(0, 8).map((b) => ({ atMs: b.atMs, body: { ...b.body, 'loadInfo.hall1Watt': fx.movingCircuits(1) } }));
  for (const b of frozen) r.feed(b.atMs, b.body);
  assert.notEqual((r.store.get().devices[PANEL_SN] as any).contentStaleSinceMs ?? null, null, 'latched: a red test on such a fixture would prove nothing');
});

/* ══ the fold ══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the 2026-11-14 loss through the store: no alarm at the 06:45Z body, the alarm at the 06:46Z body, word for word', () => {
  const r = rig();
  feedAll(r, lossBodies, iso('2026-11-15T06:45:00Z'));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, 'present at T−1? no: nothing stands at 06:45Z');
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['off']);
  feedAll(r, lossBodies.filter((b) => b.atMs === iso('2026-11-15T06:46:00Z')));
  const parts = r.store.poolOutAlerts(r.clock.ms + 20_000).get(PANEL_SN)!;
  assert.deepEqual([parts.severity, parts.title, parts.fault], ['warning', 'Core out of the backup pool: slot 1', 'out:1;k=1']);
  assert.equal(parts.detail, [
    "The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.",
    'It first read under the sum of its slots at 23:36; the last reading at 92.2 kWh was at 23:35.',
    'At 23:46 slot 1 delivered 0 W while slots 2 and 3 delivered 1,083 W and 1,030 W.',
    'Slot 1 is listed as connected and reads 72%.',
    "The panel's cloud data carries no error code for slot 1 and three empty error lists.",
    'Cause not established.',
    'Backup now: 39.0 kWh of 61.4 kWh counted (63.5%).',
    'Grid presence is not known right now.', // no grid source is wired in this test: not known, never "absent"
  ].join(' '));
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['on']);
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms), null, 'no return notice while the alarm stands');
});

test('★★★ the 2026-11-16 return through the store: standing at the 03:18Z body, ended at the 03:19Z body, with the return notice', () => {
  const r = rig();
  feedAll(r, lossBodies);
  feedAll(r, returnBodies, iso('2026-11-17T03:18:00Z'));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)?.title, 'Core out of the backup pool: slot 1', '★ present at T−1');
  assert.equal(r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)?.detail.startsWith(
    "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier."), true, 'the lead while the clear is pending is the present reading');
  feedAll(r, returnBodies.filter((b) => b.atMs === iso('2026-11-17T03:19:00Z')));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, '★ gone at T');
  assert.deepEqual(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms + 20_000), {
    title: 'Core back in the backup pool: slot 1',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier.",
      'At 20:09 slot 1 delivered 874 W and read 99%.',
      'The pool percent read 47% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
      'Backup at 20:19: 59.0 kWh of 92.2 kWh counted (64%).',
    ].join(' '),
  });
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['off']);
  assert.equal(r.store.poolOutEndNotice(OTHER_PANEL, r.clock.ms), null, 'a panel with no tracker has no notice');
});

test('★★★ what the store logs for the two fixtures: the panel\'s own fields when they change, then what the tracker made of the body — and no serial', () => {
  const r = rig();
  feedAll(r, lossBodies);
  feedAll(r, returnBodies);
  const logged = pool(r.lines).map((l) => l.replace(/ \((?:capacity|STRONG).*$/, ' (…)'));
  assert.deepEqual(logged, [
    'pool-diag: first reading taken (83 fields); changes are logged from here.',
    'pool-out: reference adopted — slots 1, 2 and 3, 92.2 kWh.',
    'pool-out: percent or power points at a slot while the capacity does not — recorded, not alarmed (…)',
    'pool-diag: backupIncreInfo.backupFullCap 92160 → 61440',
    'pool-diag: pd303_mc.backupIncreInfo.backupFullCap 92160 → 61440',
    'pool-out: streak started (…)',
    'pool-out: captured the panel\'s keys at "first-fault" (1 capture kept).',
    'pool-out: RAISED (strong) — Core out of the backup pool: slot 1; first fault reading 2026-11-15T06:36:00.000Z; capacity fault (61.4 of 92.2 kWh, 1 slot short); percent fault (slot 1); power fault (slot 1); flags no vote.',
    'pool-out: captured the panel\'s keys at "raised" (2 captures kept).',
    'pool-out: the capacity is 1 slot short while every slot carries its share — held, not counted (…)',
    'pool-diag: backupIncreInfo.backupFullCap 61440 → 92160',
    'pool-diag: pd303_mc.backupIncreInfo.backupFullCap 61440 → 92160',
    'pool-out: the capacity reads the sum of its slots again (92.2 kWh) — the alarm stands until that has held (…)',
    'pool-out: CLEARED (returned) — Core out of the backup pool: slot 1; the capacity has read 92.2 kWh for 11 readings over 10 min; capacity healthy (92.2 kWh); percent consistent; power unknown (missing); flags no vote.',
    'pool-out: captured the panel\'s keys at "ended" (3 captures kept).',
  ]);
  // The raise and the clear go to the warn sink (level 40); nothing else of this does.
  assert.deepEqual(r.warns.filter((l) => /^pool-/.test(l)).map((l) => l.slice(0, l.indexOf(')') + 1)), ['pool-out: RAISED (strong)', 'pool-out: CLEARED (returned)']);
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(pool(r.lines).join('\n').includes(sn), false, '★ no serial in any line');
});

test('★★★ the capture files: one at the first fault reading, the raise and the end; allowlisted keys only; no serial', () => {
  const r = rig();
  feedAll(r, lossBodies);
  feedAll(r, returnBodies);
  assert.deepEqual(r.store.poolEventNames(), [
    'pool-event-2026-11-15T06-36-00Z-first-fault.json', 'pool-event-2026-11-15T06-46-00Z-raised.json', 'pool-event-2026-11-17T03-19-00Z-ended.json',
  ]);
  assert.deepEqual(readdirSync(r.events).sort(), r.store.poolEventNames(), 'and nothing else is left in the folder (no temp file)');
  for (const name of r.store.poolEventNames()) {
    const fileText = readFileSync(join(r.events, name), 'utf8');
    const cap = JSON.parse(fileText);
    assert.equal(cap.panel, 'house panel');
    const keys = Object.keys(cap.keys);
    assert.deepEqual(keys.filter((k) => /(^|\.)(sn|chName|area|localTime|timeZone)$/.test(k)), [], `${name}: none of the dropped keys`);
    assert.equal(keys.every((k) => k.startsWith('pd303_mc.') || k.startsWith('backupIncreInfo.') || k === 'backupInfo.chWatt' || !k.includes('.')), true, name);
    assert.equal(keys.some((k) => k.startsWith('loadInfo.') || k.startsWith('wattInfo.')), false, `${name}: no circuit or grid-watt key`);
    for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(fileText.includes(sn), false, `${name}: no serial`);
  }
  const raised = JSON.parse(readFileSync(join(r.events, 'pool-event-2026-11-15T06-46-00Z-raised.json'), 'utf8'));
  assert.deepEqual([raised.kind, raised.at, raised.keys['backupIncreInfo.backupFullCap'], raised.keys['backupInfo.chWatt'][0]], ['raised', '2026-11-15T06:46:00.000Z', 61440, 0]);
  assert.match(raised.verdicts, /^capacity fault \(61\.4 of 92\.2 kWh, 1 slot short\); percent fault \(slot 1\); power fault \(slot 1\)/);
});

test('★★ the newest twenty capture files are kept; a file that is not a capture is never removed; no folder, no capture and no error', async () => {
  const { POOL_EVENT_FILE } = await record();
  const r = rig();
  mkdirSync(r.events, { recursive: true });
  writeFileSync(join(r.events, 'notes.txt'), 'kept');
  // A Core that leaves and rejoins: every streak start is a first fault reading.
  let m = -15;
  for (let i = 0; i < 15; i++) r.feed(at(m), healthyBody(m++));
  for (let cycle = 0; cycle < 24; cycle++) {
    r.feed(at(m), lostBody(m++));
    for (let i = 0; i < 4; i++) r.feed(at(m), healthyBody(m++)); // three healthy readings over two minutes end the streak
    m += 70; // past the flap window, so the cycles do not add up to a raise
  }
  const names = r.store.poolEventNames();
  assert.equal(names.length, 20, `kept: ${names.length}`);
  assert.equal(names.every((n) => POOL_EVENT_FILE.test(n) && n.endsWith('-first-fault.json')), true);
  assert.deepEqual([...names].sort(), names, 'oldest first');
  assert.equal(pool(r.lines).filter((l) => l.includes('captured the panel\'s keys at "first-fault"')).length, 24, 'control: 24 were written');
  assert.equal(readFileSync(join(r.events, 'notes.txt'), 'utf8'), 'kept', '★ only capture files are pruned');
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, 'control: no alarm from these separate dips');

  const none = rig({ events: null });
  feedAll(none, lossBodies);
  assert.deepEqual(none.store.poolEventNames(), []);
  assert.equal(none.store.poolOutAlerts(none.clock.ms).size, 1, '★ the alarm does not depend on the captures');
  assert.equal(none.warns.some((l) => l.includes('could not write an event capture')), false);
});

test('★★★ a run of streak starts cannot push the capture of a RAISE out of the files kept: the oldest first-fault captures go first', () => {
  const r = rig();
  // An episode: its first fault reading, its raise and its end (three captures).
  feedAll(r, lossBodies);
  feedAll(r, returnBodies);
  const episode = r.store.poolEventNames();
  assert.deepEqual(episode.map((n) => n.replace(/^.*Z-/, '')), ['first-fault.json', 'raised.json', 'ended.json']);
  // Then a capacity that dips for one reading every 75 minutes, thirty times: thirty first-fault captures.
  let m = Math.round((returnBodies[returnBodies.length - 1].atMs - at(0)) / MIN) + 10;
  for (let cycle = 0; cycle < 30; cycle++) {
    r.feed(at(m), lostBody(m++));
    for (let i = 0; i < 4; i++) r.feed(at(m), healthyBody(m++));
    m += 70;
  }
  const names = r.store.poolEventNames();
  assert.equal(names.length, 20);
  assert.equal(pool(r.lines).filter((l) => l.includes('captured the panel\'s keys at "first-fault"')).length, 31, 'control: 31 first-fault captures were written in all');
  assert.equal(names.includes(episode[1]), true, '★ the capture of the raise is still there');
  assert.equal(names.includes(episode[2]), true, '★ and the capture of the end');
  assert.equal(names.includes(episode[0]), false, 'the oldest first-fault capture is the first to go');
  assert.equal(names.filter((n) => n.endsWith('-first-fault.json')).length, 18);
  assert.equal(pool(r.lines).filter((l) => l.endsWith('(20 captures kept).')).length > 0, true);
});

test('★★ an event capture that cannot be written is said once at warn, and the alarm is unaffected', () => {
  const blocked = join(ROOT, 'a-file-not-a-folder');
  writeFileSync(blocked, 'x');
  const r = rig({ events: join(blocked, 'pool-events') });
  feedAll(r, lossBodies);
  assert.equal(r.warns.filter((l) => l.startsWith('pool-out: could not write an event capture')).length, 1);
  assert.equal(r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)?.severity, 'warning');
});

/* ══ which bodies are folded, and with what ═════════════════════════════════════════════════════════ */

test('★★★ only a REST body is folded: an MQTT-sourced quota moves nothing in the tracker', () => {
  const r = rig();
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 20; m++) { r.clock.ms = at(m); r.store.setDeviceQuota(PANEL_SN, lostBody(m), 'mqtt'); }
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0);
  assert.equal(pool(r.lines).some((l) => l.includes('streak started')), false);
  for (let m = 21; m <= 31; m++) r.feed(at(m), lostBody(m));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1, 'control: the same bodies over REST raise');
});

test('★★★ a panel the cloud lists OFFLINE: its bodies, new content each, are no observations — the store hands the tracker the panel\'s listing', async () => {
  const offline = listed(PANEL_SN).map((d) => ({ ...d, online: 0 }));
  const r = rig();
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 20; m++) { r.store.setDeviceList(offline); r.feed(at(m), lostBody(m)); }
  assert.equal((r.store.get().devices[PANEL_SN] as any).online, false, 'control: listed offline');
  assert.equal((r.store.get().devices[PANEL_SN] as any).contentNewAtMs, at(20), 'control: each body was new content');
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, '★ twenty-one bodies one Core short raise nothing');
  assert.equal((r.store.poolOutDebug(r.clock.ms) as any).panels[0].lastSkip, 'offline');
  assert.equal(pool(r.lines).some((l) => l.includes('streak started')), false);
  // Listed online again: the same shape raises after its dwell.
  for (let m = 21; m <= 31; m++) { r.store.setDeviceList(listed(PANEL_SN)); r.feed(at(m), lostBody(m)); }
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1, 'control');
});

test('★★★ while the stale-shadow latch is set no body is an observation, even one whose content is new: the latch is handed to the tracker as it stands after the poll', () => {
  const r = rig();
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  const frozen = healthyBody(-1);
  for (let m = 0; m <= 6; m++) r.feed(at(m), frozen); // the cloud replays one body: the latch sets
  const latched = (): boolean => ((r.store.get().devices[PANEL_SN] as any).contentStaleSinceMs ?? null) != null;
  assert.equal(latched(), true, 'control: latched after the replays');
  // A new body one Core short, then the frozen body again, for forty minutes: each new body is one "movement" of the
  // three the latch needs, and the frozen body's return resets the count. The latch never releases.
  for (let m = 7; m <= 47; m++) {
    r.feed(at(m), m % 2 === 1 ? lostBody(m) : frozen);
    assert.equal(latched(), true, `control: still latched at minute ${m}`);
  }
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, '★ twenty new-looking readings one Core short, behind a latch: no alarm');
  assert.equal(pool(r.lines).some((l) => l.includes('streak started')), false, '★ and no streak');
  assert.deepEqual(r.store.poolRecord(PANEL_SN).signals, null, 'the newest body was skipped');
  // Control: the same lost bodies once the content really moves (three distinct in a row release the latch) do raise.
  for (let m = 48; m <= 62; m++) r.feed(at(m), lostBody(m));
  assert.equal(latched(), false, 'control: released');
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1, 'control: and the alarm follows its dwell');
});

test('★★★ the body is stamped with ITS time (the store\'s data clock), never the wall clock', (t) => {
  const r = rig();
  // The wall clock sits two hours ahead of the data throughout.
  t.mock.method(Date, 'now', () => r.clock.ms + 120 * MIN);
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 10; m++) r.feed(at(m), lostBody(m));
  const parts = r.store.poolOutAlerts(at(10)).get(PANEL_SN)!;
  assert.match(parts.detail, /It first read under the sum of its slots at 23:00; the last reading at 92\.2 kWh was at 22:59\./, '★ the body\'s minutes, not the wall clock\'s');
  const st = parsePoolOutFile(readFileSync(r.file, 'utf8')).panels.get(PANEL_SN)!;
  assert.deepEqual([st.episode?.sinceMs, st.episode?.raisedAtMs, st.lastUsableMs], [at(0), at(10), at(10)]);
});

test('★★★ a streak is carried across a restart only by DATA time: 15 minutes from its last reading carries it, 15 min 1 s starts it again — whatever the wall clock at construction', (t) => {
  const first = rig();
  for (let m = -15; m < 0; m++) first.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 3; m++) first.feed(at(m), lostBody(m)); // four STRONG readings, 3 minutes: no raise
  const onFile = parsePoolOutFile(readFileSync(first.file, 'utf8')).panels.get(PANEL_SN)!;
  assert.deepEqual([onFile.streak?.counted, onFile.streak?.lastMs, onFile.episode], [4, at(3), null], 'control: the streak is on file');

  for (const [gapMs, carried] of [[15 * MIN, true], [15 * MIN + 1000, false]] as const) {
    const copy = join(ROOT, `carry-${gapMs}.json`);
    writeFileSync(copy, readFileSync(first.file, 'utf8'));
    // The process starts a day later by the wall clock; the first body is `gapMs` after the streak's last by data time.
    const wall = t.mock.method(Date, 'now', () => at(3) + 24 * 60 * MIN);
    const r = rig({ file: copy });
    r.feed(at(3) + gapMs, lostBody(100));
    wall.mock.restore();
    const st = parsePoolOutFile(readFileSync(copy, 'utf8')).panels.get(PANEL_SN)!;
    assert.equal(pool(r.lines).some((l) => l.startsWith('pool-out: streak restarted')), !carried, `gap ${gapMs / 1000} s`);
    assert.deepEqual([st.streak?.counted, st.streak?.firstMs], carried ? [5, at(0)] : [1, at(3) + gapMs], `gap ${gapMs / 1000} s`);
    assert.equal(r.lines.some((l) => l.includes('a streak is on file and is carried only if the next reading comes within 15 min of its last')), true);
  }
});

test('★★★ the grid: with NO source wired, or one that fails, it is not known — a panel reading "no grid" alone never makes the alarm critical', () => {
  for (const source of [undefined, () => { throw new Error('resolver failed'); }, () => null] as const) {
    const r = rig();
    if (source) r.store.setPoolOutGridSource(source as any);
    for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
    for (let m = 0; m <= 20; m++) r.feed(at(m), lostBody(m, { gridSta: 0 }));
    const parts = r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)!;
    assert.equal(parts.severity, 'warning', '★ held at warning: twenty readings of gridSta 0 with no verdict from the add-on');
    assert.match(parts.detail, /Grid presence is not known right now\.$/);
  }
  // Control: the same readings WITH the add-on's verdict "absent, and not merely unheard" are critical from the third.
  const r = rig();
  r.store.setPoolOutGridSource(() => ({ present: false, presenceUnknown: false }));
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 20; m++) r.feed(at(m), lostBody(m, { gridSta: 0 }));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)?.severity, 'critical');
  // …and a verdict that is only "unheard" holds the warning.
  const u = rig();
  u.store.setPoolOutGridSource(() => ({ present: false, presenceUnknown: true }));
  for (let m = -15; m < 0; m++) u.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 20; m++) u.feed(at(m), lostBody(m, { gridSta: 0 }));
  assert.equal(u.store.poolOutAlerts(u.clock.ms).get(PANEL_SN)?.severity, 'warning');
});

test('★★ the grid source is asked for THIS panel, at this body', () => {
  const r = rig();
  const asked: string[] = [];
  r.store.setPoolOutGridSource((sn) => { asked.push(sn); return { present: true, presenceUnknown: false }; });
  r.feed(at(0), healthyBody(0));
  r.feed(at(1), healthyBody(1));
  assert.deepEqual(asked, [PANEL_SN, PANEL_SN]);
});

test('★★★ the change log reads only NEW content: a replayed older body between two new ones invents no transition', () => {
  const r = rig();
  const off = { set: { 'pd303_mc.backupIncreInfo.Energy1Info.isPowerOutput': 0 } };
  r.feed(at(0), healthyBody(0));
  r.feed(at(1), healthyBody(1));
  r.feed(at(2), healthyBody(2, off));
  r.feed(at(3), healthyBody(1)); // the cloud serves the 23:01 body again: isPowerOutput 1 in it
  r.feed(at(4), healthyBody(4, off));
  assert.deepEqual(pool(r.lines).filter((l) => l.includes('isPowerOutput')), ['pool-diag: slot 1 isPowerOutput 1 → 0'], '★ one transition, not three');
  // Control: the same value arriving in a NEW body is a transition.
  r.feed(at(5), healthyBody(5));
  assert.deepEqual(pool(r.lines).filter((l) => l.includes('isPowerOutput')), ['pool-diag: slot 1 isPowerOutput 1 → 0', 'pool-diag: slot 1 isPowerOutput 0 → 1']);
});

test('★★ an error code is logged at first sight — the body it first appears in, three minutes before the source-error alarm\'s debounce ends', () => {
  const r = rig();
  r.feed(at(0), healthyBody(0));
  r.feed(at(1), healthyBody(1, { slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637, errorCodeNum: 533 }, { pct: 63, w: -601 }] }));
  assert.deepEqual(pool(r.lines).filter((l) => l.includes('errorCodeNum')), ['pool-diag: slot 2 errorCodeNum 0 → 533']);
  assert.deepEqual(r.store.shp2SrcErrOnsets().get(`${PANEL_SN}:2`), { count: 533, sinceMs: at(1) }, 'control: the existing debounce clock starts at the same body');
});

test('★★ two panels: each line names its panel by ROLE; each has its own tracker, capture suffix and sensor state', () => {
  const r = rig({ panels: [PANEL_SN, OTHER_PANEL] });
  r.store.pinHousePanel(PANEL_SN);
  for (let m = -15; m < 0; m++) { r.feed(at(m), healthyBody(m)); r.feed(at(m), quietBody(m + 5000), OTHER_PANEL); }
  for (let m = 0; m <= 10; m++) { r.feed(at(m), healthyBody(m)); r.feed(at(m), lostBody(m + 5000), OTHER_PANEL); }
  assert.deepEqual([...r.store.poolOutAlerts(r.clock.ms).keys()], [OTHER_PANEL], 'only the garage panel\'s tracker raised');
  const tagged = pool(r.lines);
  assert.equal(tagged.every((l) => /^pool-(out|diag) \[(house panel|panel 2)\]/.test(l)), true, tagged.find((l) => !/^pool-(out|diag) \[/.test(l)));
  assert.equal(tagged.some((l) => l.startsWith('pool-out [panel 2]: RAISED (strong) — Core out of the backup pool: slot 1')), true);
  assert.equal(tagged.some((l) => l.startsWith('pool-out [house panel]: RAISED')), false);
  for (const sn of [PANEL_SN, OTHER_PANEL, ...CORE_SNS]) assert.equal(tagged.join('\n').includes(sn), false, '★ no serial');
  assert.deepEqual(r.store.poolEventNames().map((n) => n.replace(/^pool-event-[0-9T-]+Z-/, '')), ['first-fault-p2.json', 'raised-p2.json']);
  assert.equal(JSON.parse(readFileSync(join(r.events, r.store.poolEventNames()[0]), 'utf8')).panel, 'panel 2');
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['off', 'on'], 'by serial: the house panel off, the garage panel on');
  // A panel that leaves the account stops holding the plant's state at unknown; one with an alarm standing never drops out.
  for (let i = 0; i < 3; i++) r.store.setDeviceList(listed(OTHER_PANEL));
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['on'], 'the house panel is off the account after three lists without it');
  for (let i = 0; i < 3; i++) r.store.setDeviceList(listed(PANEL_SN));
  assert.deepEqual(r.store.poolOutSensorStates(r.clock.ms), ['off', 'on'], '★ the garage panel is off the account, and its standing alarm still counts');
});

/* ══ the state file ═════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the state is saved at once on a change; otherwise at most once a minute and only while a streak or an alarm stands', async () => {
  const { parsePoolDiagSigs } = await record();
  const r = rig();
  const mtimes: number[] = [];
  const saved = (): number => (existsSync(r.file) ? statSync(r.file).mtimeMs : -1);
  const fedAt = (ms: number, body: Body): boolean => { const before = readOrNull(r.file); r.feed(ms, body); mtimes.push(saved()); return readOrNull(r.file) !== before; };
  const readOrNull = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  // The first body: the change log's first signature is a change, so the file appears.
  assert.equal(fedAt(at(-20), healthyBody(-20)), true);
  // Healthy minutes with nothing standing and nothing changing: no write — until the reference is adopted (a change).
  const writes: number[] = [];
  for (let m = -19; m <= -1; m++) if (fedAt(at(m), healthyBody(m))) writes.push(m);
  assert.deepEqual(writes, [-10], '★ exactly one write in nineteen healthy minutes: the reference, at its tenth minute');
  // A streak stands: bodies 20 s apart are saved at most once a minute.
  const streak: number[] = [];
  for (let k = 0; k < 9; k++) if (fedAt(at(0) + k * 20_000, lostBody(900 + k))) streak.push(k);
  assert.deepEqual(streak, [0, 1, 4, 7], '★ at the streak\'s start and at its second reading (both changes: the start, then a confirmed loss step), then once a minute');
  assert.equal(POOL_OUT_PERSIST_EVERY_MS, 60_000);
  const st = parsePoolOutFile(readFileSync(r.file, 'utf8'));
  assert.deepEqual([st.rejected, st.panels.get(PANEL_SN)?.streak?.counted], [0, 8], 'the file holds the streak as of its last save (the eighth of nine readings)');
  assert.equal(parsePoolDiagSigs(readFileSync(r.file, 'utf8')).get(PANEL_SN)?.['backupIncreInfo.backupFullCap'], '61440', 'and the change log\'s signature beside it');
  assert.equal(JSON.stringify(JSON.parse(readFileSync(r.file, 'utf8')).panels[PANEL_SN]).includes('"proc"'), false, 'what happened in this process is never written');
});

test('★★★ a restart restores a standing alarm before any body arrives; the first body after it neither clears nor repeats it', () => {
  const first = rig();
  feedAll(first, lossBodies);
  const before = first.store.poolOutAlerts(first.clock.ms).get(PANEL_SN)!;

  const r = rig({ file: first.file });
  assert.deepEqual(r.lines.filter((l) => l.startsWith('pool-out: state restored')), [
    'pool-out: state restored for 1 panel — "Core out of the backup pool: slot 1" standing since 2026-11-15T06:36:00.000Z.',
  ]);
  const restored = r.store.poolOutAlerts(first.clock.ms).get(PANEL_SN)!;
  assert.deepEqual([restored.title, restored.fault, restored.severity, restored.detail], [before.title, before.fault, before.severity, before.detail], '★ the same alarm, word for word, with no body fed');
  assert.deepEqual(r.store.poolOutSensorStates(first.clock.ms), ['on']);
  assert.equal(r.store.poolOutOrphanReleased(PANEL_SN), false, 'restored is not "raised in this process"');
  // 43 hours later the first body of the return fixture (still one Core short): the same alarm, no new raise, no change line.
  r.feed(returnBodies[0].atMs, returnBodies[0].body);
  assert.equal(r.store.poolOutAlerts(r.clock.ms).get(PANEL_SN)?.fault, 'out:1;k=1');
  assert.equal(pool(r.lines).some((l) => /RAISED|streak started|first reading taken|backupFullCap/.test(l)), false, pool(r.lines).join('\n'));
  // …and the rest of the return clears it on evidence, in the second process.
  feedAll(r, returnBodies.slice(1));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0);
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms)?.title, 'Core back in the backup pool: slot 1');
  assert.equal(r.store.poolOutOrphanReleased(PANEL_SN), true, 'a full clear dwell was seen in this process');
});

test('★★★ the id and the panel\'s name are LATCHED at the raise and kept with the state: after a restart with NO device list the alarm still has both, and they are let go at the end', () => {
  const first = rig();
  feedAll(first, lossBodies, iso('2026-11-15T06:45:00Z'));
  assert.equal(JSON.parse(readFileSync(first.file, 'utf8')).cards?.[PANEL_SN], undefined, 'control: nothing latched before the raise');
  feedAll(first, lossBodies.filter((b) => b.atMs === iso('2026-11-15T06:46:00Z')));
  assert.deepEqual(JSON.parse(readFileSync(first.file, 'utf8')).cards, { [PANEL_SN]: { id: 'shp2-pool-out', device: 'Smart Home Panel 2' } }, '★ on file at the raise');
  assert.deepEqual(first.store.poolOutAlerts(first.clock.ms).get(PANEL_SN)?.card, { id: 'shp2-pool-out', device: 'Smart Home Panel 2' });

  // The restart: the same file, and NO device list (the cloud cannot be reached).
  const store = new SnapshotStore({ poolOutPath: first.file, poolEventsDir: null });
  assert.deepEqual(Object.keys(store.get().devices), [], 'control: no device is listed');
  const standing = store.poolOutAlerts(first.clock.ms + 7 * MIN).get(PANEL_SN);
  assert.deepEqual([standing?.title, standing?.card], ['Core out of the backup pool: slot 1', { id: 'shp2-pool-out', device: 'Smart Home Panel 2' }], '★ restored with its id and its name');

  // At the end the latch is let go, on file too.
  feedAll(first, lossBodies.filter((b) => b.atMs > iso('2026-11-15T06:46:00Z')));
  feedAll(first, returnBodies);
  assert.equal(first.store.poolOutAlerts(first.clock.ms).size, 0, 'control: ended');
  assert.deepEqual(JSON.parse(readFileSync(first.file, 'utf8')).cards, {});
  // A card on file for a panel with no alarm standing, or one whose id is not this panel's, is not restored.
  const tampered = join(ROOT, 'tampered-cards.json');
  const good = JSON.parse(readFileSync(first.file, 'utf8'));
  writeFileSync(tampered, JSON.stringify({ ...good, cards: { [PANEL_SN]: { id: 'shp2-pool-out', device: 'x' }, [OTHER_PANEL]: { id: `shp2-pool-out-${PANEL_SN}`, device: 'y' } } }));
  assert.equal(new SnapshotStore({ poolOutPath: tampered, poolEventsDir: null }).poolOutAlerts(first.clock.ms).size, 0);
  // …and the next alarm on that panel is latched afresh, from the device list, not shown under the stale card.
  const later = rig({ file: tampered });
  for (let m = 5000; m <= 5010; m++) later.feed(at(m), lostBody(m));
  assert.deepEqual(later.store.poolOutAlerts(later.clock.ms).get(PANEL_SN)?.card, { id: 'shp2-pool-out', device: 'Smart Home Panel 2' });
});

test('★★★ two panels: a standing alarm keeps the id it was raised under when the house pin moves to the other panel, and a second alarm never takes an id that is held', () => {
  // Raised on the first panel while IT is the house panel: the bare id.
  const a = rig({ panels: [PANEL_SN, OTHER_PANEL] });
  a.store.pinHousePanel(PANEL_SN);
  for (let m = -15; m < 0; m++) { a.feed(at(m), healthyBody(m), PANEL_SN); a.feed(at(m), healthyBody(m + 4000), OTHER_PANEL); }
  for (let m = 0; m <= 10; m++) { a.feed(at(m), lostBody(m), PANEL_SN); a.feed(at(m), healthyBody(m + 4000), OTHER_PANEL); }
  assert.equal(a.store.poolOutAlerts(a.clock.ms).get(PANEL_SN)?.card?.id, 'shp2-pool-out');
  // The pin moves to the other panel. The standing alarm's id does not.
  a.store.pinHousePanel(OTHER_PANEL);
  assert.equal(a.store.poolOutAlerts(a.clock.ms).get(PANEL_SN)?.card?.id, 'shp2-pool-out', '★ the same id: nothing is resolved and pushed again');
  // Now the other panel (the house panel by the pin) loses a Core too: the bare id is held, so it takes its own.
  for (let m = 11; m <= 21; m++) { a.feed(at(m), lostBody(m), PANEL_SN); a.feed(at(m), lostBody(m + 4000), OTHER_PANEL); }
  const both = a.store.poolOutAlerts(a.clock.ms);
  assert.deepEqual([...both].map(([sn, p]) => [sn, p.card?.id]).sort(), [[PANEL_SN, 'shp2-pool-out'], [OTHER_PANEL, `shp2-pool-out-${OTHER_PANEL}`]].sort(), '★ two alarms, two ids');
  // Across a restart both are as they were.
  const b = new SnapshotStore({ poolOutPath: a.file, poolEventsDir: null });
  assert.deepEqual([...b.poolOutAlerts(a.clock.ms)].map(([sn, p]) => [sn, p.card?.id, p.card?.device]).sort(), [[PANEL_SN, 'shp2-pool-out', 'Smart Home Panel 2'], [OTHER_PANEL, `shp2-pool-out-${OTHER_PANEL}`, 'Garage Panel']].sort());
  // A state file from before the latch (an episode and no card): latched at the first pass that has the device list.
  const old = JSON.parse(readFileSync(a.file, 'utf8'));
  delete old.cards;
  const bare = join(ROOT, 'no-cards.json');
  writeFileSync(bare, JSON.stringify(old));
  const c = new SnapshotStore({ poolOutPath: bare, poolEventsDir: null });
  assert.equal(c.poolOutAlerts(a.clock.ms).get(PANEL_SN)?.card, null, 'no list yet, nothing latched: no name to show it under');
  c.setDeviceList(listed(PANEL_SN, OTHER_PANEL));
  assert.deepEqual(c.poolOutAlerts(a.clock.ms).get(PANEL_SN)?.card?.device, 'Smart Home Panel 2');
});

test('★★★ an end record on file and a NEW alarm standing: no return notice is served for the panel (it would announce a return while a Core is out)', () => {
  const r = rig();
  for (let m = -15; m < 0; m++) r.feed(at(m), healthyBody(m));
  for (let m = 0; m <= 10; m++) r.feed(at(m), lostBody(m));
  for (let m = 11; m <= 21; m++) r.feed(at(m), healthyBody(m));
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms)?.title, 'Core back in the backup pool: slot 1', 'control: the first episode ended and its notice is on record');
  // The boot sweep asks for an end at or after the push it resolves: an end OLDER than that push is another episode's.
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms, at(21))?.title, 'Core back in the backup pool: slot 1', 'the end at minute 21 answers a push at minute 21 or before');
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms, at(21) + 1), null, '★ and not one after it');
  for (let m = 30; m <= 40; m++) r.feed(at(m), lostBody(m));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1, 'control: a second alarm stands');
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms), null, '★ no notice while it stands');
  assert.equal(r.store.poolOutEndNotice('HD31XXX00XXX0009', r.clock.ms), null, 'nor for a panel with no state');
});

test('★★★ a lost, corrupt or half-valid state file: nothing is invented, the rest is restored, and it is said', () => {
  const first = rig();
  feedAll(first, lossBodies);
  const good = JSON.parse(readFileSync(first.file, 'utf8'));

  const missing = rig({ file: join(ROOT, 'never-written.json') });
  assert.deepEqual([missing.store.poolOutAlerts(at(0)).size, missing.store.poolOutSensorStates(at(0))], [0, ['unknown']], 'no file: unknown, not OFF');
  assert.equal(missing.lines.some((l) => l.startsWith('pool-out:')), false);
  assert.equal(missing.store.poolOutOrphanReleased(PANEL_SN), false, '★ a panel with no tracker state has neither raised nor seen a clean dwell');

  const corrupt = join(ROOT, 'corrupt.json');
  writeFileSync(corrupt, '{"v":1,"panels":{"HD31XXX00XXX0001":');
  const c = rig({ file: corrupt });
  assert.equal(c.store.poolOutAlerts(at(0)).size, 0);
  assert.deepEqual(c.lines.filter((l) => l.startsWith('pool-out:')), [
    'pool-out: 1 entry of the state file could not be read and is left out — that panel starts with no reference and no alarm.',
    'pool-out: the file as it was read is kept as corrupt.json.unread; the next save replaces corrupt.json.',
  ]);

  const half = join(ROOT, 'half.json');
  writeFileSync(half, JSON.stringify({ v: 1, panels: { [PANEL_SN]: good.panels[PANEL_SN], [OTHER_PANEL]: { v: 1, episode: { k: 0 } } }, diag: good.diag }));
  const h = rig({ file: half, panels: [PANEL_SN, OTHER_PANEL] });
  assert.deepEqual([...h.store.poolOutAlerts(first.clock.ms).keys()], [PANEL_SN], 'the valid panel is restored, the other is left out');
  assert.equal(h.lines.filter((l) => l.startsWith('pool-out:')).length, 3, 'what was left out, what was restored, and where the file as read is kept');
});

test('★★★ a state file that cannot be read is KEPT beside the one the first save writes: a newer version\'s file after a rollback is not destroyed', () => {
  const first = rig();
  feedAll(first, lossBodies);
  const written = readFileSync(first.file, 'utf8');
  const cases: Array<[string, string]> = [
    ['a file of a later version', JSON.stringify({ ...JSON.parse(written), v: 2 })],
    ['a panel entry of a later version', JSON.stringify({ ...JSON.parse(written), panels: { [PANEL_SN]: { ...JSON.parse(written).panels[PANEL_SN], v: 2 } } })],
    ['a truncated file', written.slice(0, Math.floor(written.length / 2))],
    ['an empty file', ''],
  ];
  for (const [what, fileText] of cases) {
    const file = join(ROOT, `unread-${cases.findIndex(([w]) => w === what)}.json`);
    writeFileSync(file, fileText);
    const r = rig({ file });
    assert.equal(r.store.poolOutAlerts(first.clock.ms).size, 0, `${what}: nothing is restored from it`);
    assert.equal(readFileSync(`${file}.unread`, 'utf8'), fileText, `★ ${what}: kept byte for byte`);
    assert.equal(r.lines.some((l) => l.endsWith(`.unread; the next save replaces ${file.slice(file.lastIndexOf('/') + 1)}.`)), true, `${what}: and said`);
    // The first body saves over the file itself; the copy stays.
    r.feed(first.clock.ms + MIN, lostBody(99_000));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 1, `${what}: the file is this version's again`);
    assert.equal(readFileSync(`${file}.unread`, 'utf8'), fileText, `★ ${what}: the copy is untouched by the save`);
  }
  // A file that IS read leaves no copy.
  const ok = join(ROOT, 'read-fine.json');
  writeFileSync(ok, written);
  rig({ file: ok });
  assert.equal(existsSync(`${ok}.unread`), false);
});

test('★★★ a value in the state file that cannot be restored never stops the store from being built: every panel starts empty, and it is said', () => {
  const first = rig();
  feedAll(first, lossBodies);
  const good = JSON.parse(readFileSync(first.file, 'utf8'));
  // A time no Date can hold (finite, so the shape check passes): the line that says what was restored cannot be worded.
  good.panels[PANEL_SN].episode.sinceMs = 1e20;
  const file = join(ROOT, 'unrestorable.json');
  writeFileSync(file, JSON.stringify(good));
  let r!: Rig;
  assert.doesNotThrow(() => { r = rig({ file }); }, '★ the constructor does not throw');
  assert.equal(r.store.poolOutAlerts(first.clock.ms).size, 0);
  assert.deepEqual(r.store.poolOutSensorStates(first.clock.ms), ['unknown']);
  assert.deepEqual(r.lines.filter((l) => l.startsWith('pool-out:')), [
    'pool-out: the state file could not be restored (Invalid time value) — every panel starts with no reference and no alarm.',
    'pool-out: the file as it was read is kept as unrestorable.json.unread; the next save replaces unrestorable.json.',
  ]);
  // And the store works: the same loss raises again after its dwell.
  feedAll(r, lossBodies.map((b) => ({ atMs: b.atMs + 24 * 60 * MIN, body: { ...b.body, 'loadInfo.hall1Watt': fx.movingCircuits(Math.round(b.atMs / MIN) + 7000) } })));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1);
});

test('★★ a state file in a folder that cannot be written is not believed (it may be older than the pool it describes)', { skip: process.getuid?.() === 0 ? 'root ignores folder permissions' : false }, () => {
  const first = rig();
  feedAll(first, lossBodies);
  const dir = join(ROOT, 'read-only');
  mkdirSync(dir);
  const file = join(dir, 'pool-out.json');
  writeFileSync(file, readFileSync(first.file, 'utf8'));
  chmodSync(dir, 0o555);
  try {
    const r = rig({ file });
    assert.equal(r.store.poolOutAlerts(first.clock.ms).size, 0, '★ the alarm on file is not restored');
    assert.equal(r.lines.filter((l) => l.startsWith('pool-out: the state file is not restored')).length, 1);
    // A save that fails is said once at warn; the alarm itself still works in memory.
    feedAll(r, lossBodies.map((b) => ({ atMs: b.atMs + 24 * 60 * MIN, body: { ...b.body, 'loadInfo.hall1Watt': fx.movingCircuits(Math.round(b.atMs / MIN) + 5000) } })));
    assert.equal(r.warns.filter((l) => l.startsWith("pool-out: could not save the tracker's state")).length, 1, r.warns.join('\n'));
    assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 1);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('★★ a save that fails is retried at most once a minute, and lands once the folder can be written again', { skip: process.getuid?.() === 0 ? 'root ignores folder permissions' : false }, () => {
  const dir = join(ROOT, 'flaky');
  mkdirSync(dir);
  const file = join(dir, 'pool-out.json');
  const r = rig({ file });
  chmodSync(dir, 0o555);
  try {
    r.feed(at(0), healthyBody(0)); // the first signature: a save, which fails
    assert.equal(existsSync(file), false);
    assert.equal(r.warns.filter((l) => l.startsWith("pool-out: could not save the tracker's state")).length, 1);
  } finally {
    chmodSync(dir, 0o755);
  }
  r.feed(at(0) + 30_000, healthyBody(1));
  assert.equal(existsSync(file), false, '★ 30 s after the failed attempt: not retried yet');
  r.feed(at(0) + 60_000, healthyBody(2));
  assert.equal(existsSync(file), true, '★ a minute after it: retried, and saved');
  assert.equal(r.warns.filter((l) => l.startsWith("pool-out: could not save the tracker's state")).length, 1, 'said once');
});

test('★★★ a save that FAILS removes the file it could not replace: a restart must not restore an alarm that has since ended', () => {
  const r = rig();
  feedAll(r, lossBodies);
  assert.notEqual(JSON.parse(readFileSync(r.file, 'utf8')).panels[PANEL_SN].episode, null, 'control: the alarm is on file');
  // The disk fills: every write of this state file's temp fails; the folder itself can still be written.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = ((path: any, ...rest: any[]) => {
    if (String(path).startsWith(`${r.file}.`) && String(path).endsWith('.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return (realWrite as any)(path, ...rest);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    feedAll(r, returnBodies); // the alarm ends: a change, saved at once — and the save fails
  } finally {
    fs.writeFileSync = realWrite;
    syncBuiltinESMExports();
  }
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0, 'control: the alarm ended in this process');
  assert.equal(r.warns.filter((l) => l.startsWith("pool-out: could not save the tracker's state (ENOSPC: no space left on device, write) — the file is removed, so a restart starts every panel with no reference and no alarm")).length, 1, r.warns.join('\n'));
  assert.equal(existsSync(r.file), false, '★ the file that still held the alarm is gone');
  // A restart on that path restores nothing: no alarm that ended is brought back.
  assert.equal(rig({ file: r.file }).store.poolOutAlerts(r.clock.ms).size, 0);
});

/* ══ containment: this feature records and alerts; it must never stop what was there before ═══════ */

test('★★★ a failure inside the tracker\'s fold does not stop the store from taking the panel\'s body: the projection, the clocks and the change event are as ever, and it is said once at warn', () => {
  const r = rig();
  const warns: string[] = [];
  r.store.setLogger((m) => { if (/^pool-/.test(m)) throw new Error('the log sink failed'); });
  r.store.setWarnLogger((m) => warns.push(m));
  let changes = 0;
  r.store.on('change', () => { changes += 1; });
  for (let m = 0; m < 5; m++) {
    assert.doesNotThrow(() => r.feed(at(m), healthyBody(m)), `minute ${m}`);
    const d = r.store.get().devices[PANEL_SN] as any;
    assert.deepEqual([d.lastUpdated, d.lastQuotaAtMs, d.contentNewAtMs, d.projection.backupFullCapWh], [at(m), at(m), at(m), 92160], `★ minute ${m}: the body was taken in full`);
  }
  assert.equal(changes, 5, '★ every body emitted its change (the recorder and every client read on it)');
  assert.equal(existsSync(r.file), true, '★ and the state was saved before the log line that failed');
  assert.deepEqual(warns, ['pool-out: the tracker failed on a panel reading (the log sink failed) — the reading itself is taken as usual; the pool-out alarm may have missed it.'], 'said once, not five times');
});

test('★★★ a standing alarm whose text cannot be built still stands, under its latched title — and the call the monitor makes inside every pass does not throw', () => {
  const r = rig();
  feedAll(r, lossBodies);
  const st = (r.store as any).poolOutBySn.get(PANEL_SN);
  Object.defineProperty(st, 'last', { get() { throw new Error('unreadable reading'); } });
  let parts: ReturnType<Store['poolOutAlerts']> | undefined;
  assert.doesNotThrow(() => { parts = r.store.poolOutAlerts(r.clock.ms); });
  assert.deepEqual(parts!.get(PANEL_SN), {
    severity: 'warning', title: 'Core out of the backup pool: slot 1', fault: 'out:1;k=1',
    detail: "The panel's backup capacity has read under the sum of its slots. The readings behind this alarm could not be worded; the add-on's log has them.",
    facts: [],
    card: { id: 'shp2-pool-out', device: 'Smart Home Panel 2' },
  }, '★ same id-forming fields (title, fault, severity) and the same latched id: the monitor sees the same alarm, not a new one');
  r.store.poolOutAlerts(r.clock.ms);
  assert.equal(r.warns.filter((l) => l.startsWith("pool-out: a standing alarm's text could not be built (unreadable reading)")).length, 1, 'said once');
  // A state that cannot be read at all: nothing for that panel, and still no throw.
  (r.store as any).poolOutBySn.set(PANEL_SN, new Proxy({}, { get() { throw new Error('no state'); } }));
  assert.doesNotThrow(() => r.store.poolOutAlerts(r.clock.ms));
  assert.equal(r.store.poolOutAlerts(r.clock.ms).size, 0);
  assert.doesNotThrow(() => r.store.poolOutEndNotice(PANEL_SN, r.clock.ms));
  assert.equal(r.store.poolOutEndNotice(PANEL_SN, r.clock.ms), null, '★ the resolve push then carries the usual text');
  assert.deepEqual(r.store.poolOutSensorStatesSafe(r.clock.ms), ['unknown'], '★ and Home Assistant reads unknown, never OFF');
});

/* ══ what the store serves ══════════════════════════════════════════════════════════════════════════ */

test('★★★ the debug view from the store: panels by role, the verdicts of the newest body, the captures by index — no serial, no parameter', async () => {
  const { POOL_EVENT_FILE } = await record();
  const r = rig({ panels: [PANEL_SN, OTHER_PANEL] });
  r.store.pinHousePanel(PANEL_SN);
  feedAll(r, lossBodies);
  const view = r.store.poolOutDebug(r.clock.ms) as any;
  assert.deepEqual(view.panels.map((p: any) => [p.panel, p.sensor, p.severity, p.verdicts?.class ?? null]), [['house panel', 'on', 'warning', 'STRONG'], ['panel 2', 'unknown', null, null]]);
  assert.deepEqual([view.panels[0].episode.slots, view.panels[0].baseline.poolCapWh, view.panels[0].lastDiag.pool.fullCapWh, view.panels[0].lastDiagAtMs], [[1], 92160, 61440, r.clock.ms]);
  assert.deepEqual(view.captures.map((c: any) => c.index), [0, 1]);
  assert.equal(view.captures.every((c: any) => POOL_EVENT_FILE.test(c.name)), true);
  for (const sn of [PANEL_SN, OTHER_PANEL, ...CORE_SNS]) assert.equal(JSON.stringify(view).includes(sn), false, '★ no serial');
  assert.equal(r.store.poolOutDebug.length, 1, 'it takes the time and nothing else');
  // The route hands the request nothing: index.ts is not reachable from a unit test, so its one line is pinned.
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal(index.includes("app.get('/api/debug/pool-out', async () => store.poolOutDebug(Date.now()));"), true);
});

test('★★ the recorder\'s view of a panel: the reader\'s output of the newest REST body, the verdicts on it, the tracker\'s state — a skipped body has no verdicts', () => {
  const r = rig();
  assert.deepEqual(r.store.poolRecord(PANEL_SN), { diag: null, signals: null, state: null }, 'before any body');
  feedAll(r, lossBodies);
  const rec = r.store.poolRecord(PANEL_SN);
  assert.deepEqual([rec.diag?.pool.fullCapWh, rec.signals?.cap.v, rec.signals?.cap.k, rec.state?.episode?.slots], [61440, 'fault', 1, [1]]);
  // The same body again is a replay: skipped, so no verdicts — but the alarm's state stands.
  const last = lossBodies[lossBodies.length - 1];
  r.feed(last.atMs + MIN, last.body);
  const again = r.store.poolRecord(PANEL_SN);
  assert.deepEqual([again.signals, again.state?.episode?.slots, poolOutSeverity(again.state!)], [null, [1], 'warning']);
});

test('★★★ what the reader took and what the tracker holds are the STORE\'s, never the projection\'s: none of it is in the snapshot that is cloned to the analytics worker and served to every client', () => {
  const r = rig();
  feedAll(r, lossBodies); // the alarm stands: the reader holds the newest body's fields, the tracker an episode
  const rec = r.store.poolRecord(PANEL_SN);
  assert.equal(rec.diag?.slots.length, 3, 'control: the reader took the three slots');
  assert.equal(rec.diag?.slots[0].ctrlSta?.token, 'BACKUP_CH_DISCHARGE', 'control: and their control state');
  assert.deepEqual(rec.state?.episode?.slots, [1], 'control: the tracker holds the episode');
  const snap = r.store.get();
  const projection = (snap.devices[PANEL_SN] as any).projection as Record<string, unknown>;
  assert.equal(projection.kind, 'shp2');
  assert.deepEqual(Object.keys(projection).filter((k) => /pool(diag|out)/i.test(k)), [], '★ no key of the projection carries the reader\'s output or the tracker\'s state');
  // Field names that exist only in the reader's output or in the tracker's state: as JSON keys, none is in the snapshot.
  const served = JSON.stringify(snap.devices);
  for (const name of ['ctrlSta', 'backupIsReady', 'forceChargeSta', 'errBackup', 'errMaster', 'errHall', 'fullCapMcWh', 'masterRlyCnt', 'rlyRealSta', 'lastHealthy', 'flaps', 'ring']) {
    assert.equal(served.includes(`"${name}":`), false, `★ "${name}" is not served`);
  }
});
