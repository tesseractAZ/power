/**
 * v1.208.0 — WHERE the pool-out tracker keeps its files when the caller names none, which is what production does
 * (src/index.ts builds `new SnapshotStore()` with no argument).
 *
 * Every other pool-out test hands the store its files through the constructor option, so none of them runs the line
 * that decides the path in production: `config.isAddon ? config.dataFile('pool-out.json') : null`, and the same for
 * the capture folder. With that line returning null the tracker would raise, alert and log — and save nothing: a
 * restart would forget a standing alarm, and no capture would be on disk. Every other test would still pass.
 *
 * So this file builds the store the way production does, in one process whose database path is its own folder:
 *   - outside the add-on (no SUPERVISOR_TOKEN): nothing is written beside the database, whatever the tracker does
 *     (82 test files build a store; a path taken unconditionally would be one file shared by all of them);
 *   - inside the add-on: `pool-out.json` and `pool-events/` beside the database, and the next store built with no
 *     argument restores the standing alarm before any body arrives;
 *   - a caller's own path, or `null`, wins over both.
 *
 * The bodies are the 2026-11-14 fixture (synthetic in part: the capacity, the flags and a moving circuit vector are
 * added by the builder; placeholder serials).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'ef-pool-out-path-'));
process.env.DB_PATH = join(ROOT, 'ecoflow.db');
process.env.SITE_TIMEZONE = 'America/Phoenix';
delete process.env.SUPERVISOR_TOKEN;
// Nothing else in this folder is this file's subject, and none of it may be read from another test's run.
for (const name of ['SHADOW_WITNESS_PATH', 'HOUSE_PANEL_PATH', 'POOL_UNKNOWN_PATH', 'GRID_READING_PATH']) delete process.env[name];

const { SnapshotStore } = await import('../src/snapshot.js');
const { config } = await import('../src/config.js');
const { parsePoolOutFile } = await import('../src/poolOut.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN } = fx;

type Store = InstanceType<typeof SnapshotStore>;
const LOSS = fx.loadPoolFixture('pool-loss-1114');
const lossBodies = fx.bodiesFromRows(LOSS.rows, (t) => fx.capacityAt(LOSS.capacity, t));
const iso = (s: string): number => Date.parse(s);
const LISTED = [{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any[];
const STATE = join(ROOT, 'pool-out.json');
const EVENTS = join(ROOT, 'pool-events');
const RAISED_AT = iso('2026-11-15T06:46:00Z');

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Feed the loss fixture to its raise (the 06:46Z body) into a store built as `build` says. */
function raiseIn(build: () => Store): { store: Store; lines: string[] } {
  const store = build();
  const lines: string[] = [];
  store.setLogger((m) => lines.push(m));
  store.setWarnLogger((m) => lines.push(m));
  let clock = 0;
  store.setClock(() => clock);
  store.setDeviceList(LISTED);
  for (const b of lossBodies) {
    if (b.atMs > RAISED_AT) break;
    clock = b.atMs;
    store.setDeviceQuota(PANEL_SN, b.body);
  }
  return { store, lines };
}

test('control: this process keeps its database in its own folder, and that folder is where a state file "beside the database" goes', () => {
  assert.equal(resolve(config.dataRoot), resolve(ROOT));
  assert.equal(resolve(config.dataFile('pool-out.json')), resolve(STATE));
  assert.equal(config.isAddon, false, 'no SUPERVISOR_TOKEN: not inside the add-on');
});

test('★★★ OUTSIDE the add-on a store built with no argument saves nothing: the alarm is raised, and no state file and no capture is written beside the database', () => {
  const { store, lines } = raiseIn(() => new SnapshotStore());
  assert.equal(store.poolOutAlerts(RAISED_AT).get(PANEL_SN)?.title, 'Core out of the backup pool: slot 1', 'control: the tracker ran and raised');
  assert.equal(lines.some((l) => l.startsWith('pool-out: RAISED (strong)')), true, 'control: and said so');
  assert.equal(existsSync(STATE), false, '★ no pool-out.json outside the add-on');
  assert.equal(existsSync(EVENTS), false, '★ no pool-events folder outside the add-on');
  assert.deepEqual(store.poolEventNames(), []);
  assert.equal(lines.some((l) => l.includes('captured the panel')), false);
});

test('★★★ INSIDE the add-on a store built with no argument, as production builds it, saves the raise beside the database — and the next one restores it before any body arrives', () => {
  process.env.SUPERVISOR_TOKEN = 'test-token';
  try {
    assert.equal(config.isAddon, true, 'control: the Supervisor token marks the add-on');
    const first = raiseIn(() => new SnapshotStore());
    assert.equal(existsSync(STATE), true, '★ pool-out.json beside the database');
    const saved = parsePoolOutFile(readFileSync(STATE, 'utf8'));
    assert.equal(saved.rejected, 0);
    assert.equal(saved.panels.get(PANEL_SN)?.episode?.raisedAtMs, RAISED_AT, '★ and it holds the standing episode');
    assert.deepEqual(readdirSync(EVENTS).sort(), [
      'pool-event-2026-11-15T06-36-00Z-first-fault.json',
      'pool-event-2026-11-15T06-46-00Z-raised.json',
    ], '★ the captures of the first fault reading and of the raise, in pool-events beside the database');
    assert.deepEqual(first.store.poolEventNames(), readdirSync(EVENTS).sort());

    // The restart: production's own construction again, and nothing fed.
    const second = new SnapshotStore();
    const notes: string[] = [];
    second.setLogger((m) => notes.push(m));
    second.setDeviceList(LISTED);
    const parts = second.poolOutAlerts(RAISED_AT + 60_000).get(PANEL_SN);
    assert.deepEqual([parts?.severity, parts?.title, parts?.fault], ['warning', 'Core out of the backup pool: slot 1', 'out:1;k=1'], '★ restored from the default path');
    assert.deepEqual(second.poolOutSensorStates(RAISED_AT + 60_000), ['on']);
    assert.equal(notes.some((l) => l.startsWith('pool-out: state restored for 1 panel — "Core out of the backup pool: slot 1" standing since 2026-11-15T06:36:00.000Z')), true, notes.join('\n'));
    assert.deepEqual(second.poolEventNames(), readdirSync(EVENTS).sort(), 'and it lists the captures of the same folder');
  } finally {
    delete process.env.SUPERVISOR_TOKEN;
  }
});

test('★★ production builds its one store with no argument (src/index.ts), so the paths above are the ones it gets', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal(src.split('new SnapshotStore(').length - 1, 1, 'one store is built');
  assert.equal(src.includes('const store = new SnapshotStore();'), true, '★ and it is given no pool-out path of its own');
});

test('★★ the caller\'s word wins inside the add-on too: its own path is used, and null means none', () => {
  process.env.SUPERVISOR_TOKEN = 'test-token';
  try {
    // Its own baseline beside the database (this test then runs alone as well as after the ones above).
    rmSync(STATE, { force: true });
    rmSync(EVENTS, { recursive: true, force: true });
    raiseIn(() => new SnapshotStore());
    const before = readFileSync(STATE, 'utf8');
    const own = join(ROOT, 'own', 'state.json');
    const ownEvents = join(ROOT, 'own', 'events');
    raiseIn(() => new SnapshotStore({ poolOutPath: own, poolEventsDir: ownEvents }));
    assert.equal(parsePoolOutFile(readFileSync(own, 'utf8')).panels.get(PANEL_SN)?.episode?.raisedAtMs, RAISED_AT, 'the named file holds the episode');
    assert.equal(readdirSync(ownEvents).length, 2, 'and the named folder its captures');
    const none = raiseIn(() => new SnapshotStore({ poolOutPath: null, poolEventsDir: null }));
    assert.equal(none.store.poolOutAlerts(RAISED_AT).size, 1, 'control: raised');
    assert.deepEqual(none.store.poolEventNames(), []);
    assert.equal(readFileSync(STATE, 'utf8'), before, '★ neither store touched the file beside the database');
    assert.equal(readdirSync(EVENTS).length, 2, '★ nor its capture folder');
  } finally {
    delete process.env.SUPERVISOR_TOKEN;
  }
});
