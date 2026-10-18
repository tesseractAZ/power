/**
 * The CONSOLE header's OPR seat names the signed-in TUI user (`TUI_USERNAME`),
 * or the neutral `operator` while the login is off. It was once a fixed name
 * shown on every install.
 *
 *   1. operatorSeat() — default, trimming, escape stripping and the length cap.
 *   2. renderPlant() — the header carries the seat from PlantData.operator.
 *   3. TuiSession — the production path passes the signed-in user through, and
 *      a session without a login shows the neutral seat.
 *   4. console.ts holds no hard-coded `<name>@local` literal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { operatorSeat, OPERATOR_SEAT_MAX } from '../src/telnet/plant/console.js';
import { renderPlant, type PlantData, type PlantView } from '../src/telnet/plant/index.js';
import { TuiSession, _resetAuthThrottleForTest, type TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function emptySnap(): FleetSnapshot {
  return { generatedAt: Date.now(), devices: {}, alerts: [] };
}

function plantData(operator?: string): PlantData {
  return {
    snap: emptySnap(),
    totals: null,
    forecast: null,
    degradation: { generatedAt: 0, eolSoh: 80, packs: [] },
    serverStartedAt: Date.now() - 60_000,
    flow: { fleetPv: null, fleetBatteryNet: null },
    ...(operator !== undefined ? { operator } : {}),
  };
}

const VIEW: PlantView = {
  width: 160, height: 40, screen: 'console', genSel: 0, genPack: 0, almScroll: 0, connectedAt: Date.now(),
};

function consoleText(data: PlantData): string {
  return stripAnsi(renderPlant(VIEW, data, { recorder: makeRecorderStub() }).join('\n'));
}

function dataProvider(): TuiDataProvider {
  const snap = emptySnap();
  return {
    store: { get: () => snap } as unknown as TuiDataProvider['store'],
    recorder: makeRecorderStub(),
    totals: () => null,
    forecast: () => null,
    degradation: () => null,
    serverStartedAt: Date.now() - 60_000,
  };
}

test('operatorSeat — neutral default, trimmed user, escapes stripped, long names capped', () => {
  assert.equal(operatorSeat(undefined), 'operator@local');
  assert.equal(operatorSeat(null), 'operator@local');
  assert.equal(operatorSeat('   '), 'operator@local');
  assert.equal(operatorSeat('alice'), 'alice@local');
  assert.equal(operatorSeat('  bob '), 'bob@local');
  const escaped = operatorSeat('\x1b[2Jmallory\x07');
  assert.ok(!/[\x00-\x1f\x7f]/.test(escaped), 'control bytes must not reach the terminal');
  assert.equal(escaped, '[2Jmallory@local');
  const long = operatorSeat('x'.repeat(64));
  assert.equal(long, `${'x'.repeat(OPERATOR_SEAT_MAX - 1)}…@local`);
  assert.equal(long.length - '@local'.length, OPERATOR_SEAT_MAX);
});

test('CONSOLE header — the OPR seat follows PlantData.operator', () => {
  assert.match(consoleText(plantData()), /OPR operator@local/);
  const named = consoleText(plantData('alice'));
  assert.match(named, /OPR alice@local/);
  assert.doesNotMatch(named, /operator@local/);
});

test('TuiSession — the signed-in TUI user names the seat; no login means the neutral seat', () => {
  _resetAuthThrottleForTest();
  const writes: string[] = [];
  const session = new TuiSession({
    write: (d) => writes.push(d),
    data: dataProvider(),
    width: 160,
    height: 40,
    auth: { username: 'alice', password: 'hunter2' },
  });
  const type = (text: string) => session.feed([...text].map((ch) => ({ type: 'key' as const, key: ch })));
  type('alice');
  session.feed([{ type: 'key', key: 'enter' }]);
  type('hunter2');
  session.feed([{ type: 'key', key: 'enter' }]);
  assert.equal(session.isInteractive, true, 'authenticated → console');
  session.draw();
  assert.match(stripAnsi(writes.at(-1) ?? ''), /OPR alice@local/);

  const openWrites: string[] = [];
  const open = new TuiSession({ write: (d) => openWrites.push(d), data: dataProvider(), width: 160, height: 40, auth: null });
  open.draw();
  assert.match(stripAnsi(openWrites.at(-1) ?? ''), /OPR operator@local/);
});

test('console.ts — no hard-coded operator literal', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/telnet/plant/console.ts'), 'utf8');
  assert.doesNotMatch(src, /['"`][A-Za-z0-9._-]+@local['"`]/);
});
