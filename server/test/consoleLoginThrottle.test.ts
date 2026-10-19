/**
 * The console's failed-login window is kept per peer address (1.190.0; one window
 * for every connection until then, so ten failures from any one LAN host refused
 * the operator's correct password from every other host). Driven here with an
 * explicit clock, with the SSH transport's entry points and the login card's:
 *
 *   1. Ten failures from one address refuse that address and no other, from the
 *      tenth failure until ten minutes after the first; a fresh failure once the
 *      window has opened saturates it again. Checks create no entry.
 *   2. A success clears its address; another address's failures stay.
 *   3. An IPv4 peer of a dual-stack listener (`::ffff:a.b.c.d`) shares the plain
 *      address's window: one host, one budget, whichever listener it reached.
 *   4. The table holds at most AUTH_THROTTLE_MAX_PEERS addresses; beyond that the
 *      one whose entry is oldest is dropped, the newest kept.
 *   5. The login card counts under its `peer`: ten failures from one address leave
 *      another address's card admitting the right credentials; a success clears the
 *      card's address; sessions with no peer named share AUTH_PEER_UNKNOWN.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TuiSession, consoleLoginThrottled, noteConsoleLoginFailure, noteConsoleLoginSuccess,
  _resetAuthThrottleForTest, _authThrottlePeersForTest,
  AUTH_THROTTLE_WINDOW_MS, AUTH_THROTTLE_MAX_FAILURES, AUTH_THROTTLE_MAX_PEERS, AUTH_PEER_UNKNOWN,
} from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const T0 = 1_760_000_000_000;

function mockDataProvider(): TuiDataProvider {
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
  return {
    store: { get: () => snap } as unknown as TuiDataProvider['store'],
    recorder: makeRecorderStub(),
    totals: () => null,
    forecast: () => null,
    degradation: () => null,
    serverStartedAt: Date.now() - 60_000,
  };
}

/** A login card for `peer` (none named when undefined), with the configured credentials. */
function card(peer?: string): TuiSession {
  return new TuiSession({
    write: () => {},
    data: mockDataProvider(),
    width: 100,
    height: 40,
    auth: { username: 'op', password: 'pw' },
    peer,
  });
}

/** Type a username and a password into the card and submit both. */
function submit(s: TuiSession, user: string, pass: string): { redraw?: boolean; quit?: boolean } {
  const keys = (text: string) => [...text].map((ch) => ({ type: 'key' as const, key: ch }));
  return s.feed([...keys(user), { type: 'key', key: 'enter' }, ...keys(pass), { type: 'key', key: 'enter' }]);
}

beforeEach(() => { _resetAuthThrottleForTest(); });

test('throttle — ten failures from one address refuse that address only, for ten minutes from the first failure', () => {
  const a = '10.0.0.9';
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
    assert.equal(consoleLoginThrottled(a, T0 + i * 1000), false, `attempt ${i + 1} is checked, not refused`);
    noteConsoleLoginFailure(a, T0 + i * 1000);
  }
  assert.equal(consoleLoginThrottled(a, T0 + 9000), true, 'the tenth failure saturates the address');
  assert.equal(consoleLoginThrottled('10.0.0.10', T0 + 9000), false, 'another address is not refused');
  assert.equal(_authThrottlePeersForTest(), 1, 'a check creates no entry');
  assert.equal(consoleLoginThrottled(a, T0 + AUTH_THROTTLE_WINDOW_MS - 1), true, 'refused to the last millisecond of the window');
  assert.equal(consoleLoginThrottled(a, T0 + AUTH_THROTTLE_WINDOW_MS), false, 'the first failure has aged out: nine remain');
  noteConsoleLoginFailure(a, T0 + AUTH_THROTTLE_WINDOW_MS);
  assert.equal(consoleLoginThrottled(a, T0 + AUTH_THROTTLE_WINDOW_MS), true, 'one fresh failure saturates it again');
  assert.equal(consoleLoginThrottled(a, T0 + 9000 + AUTH_THROTTLE_WINDOW_MS), false, 'the first batch has aged out: one remains');
  assert.equal(_authThrottlePeersForTest(), 1);
  assert.equal(consoleLoginThrottled(a, T0 + 2 * AUTH_THROTTLE_WINDOW_MS), false);
  assert.equal(_authThrottlePeersForTest(), 0, 'an address with no failures left has no entry');
});

test('throttle — a success clears its address; another address\'s failures stay', () => {
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) noteConsoleLoginFailure('10.0.0.9', T0);
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) noteConsoleLoginFailure('10.0.0.10', T0);
  assert.equal(_authThrottlePeersForTest(), 2);
  noteConsoleLoginSuccess('10.0.0.9');
  assert.equal(consoleLoginThrottled('10.0.0.9', T0), false);
  assert.equal(consoleLoginThrottled('10.0.0.10', T0), true);
  assert.equal(_authThrottlePeersForTest(), 1);
  noteConsoleLoginSuccess('10.0.0.11');
  assert.equal(_authThrottlePeersForTest(), 1, 'a success from an address with no failures changes nothing');
});

test('throttle — an IPv4 peer of a dual-stack listener shares the plain address\'s window', () => {
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) noteConsoleLoginFailure('::ffff:10.0.0.9', T0);
  assert.equal(consoleLoginThrottled('10.0.0.9', T0), true, 'the plain form is the same host');
  assert.equal(consoleLoginThrottled('::ffff:10.0.0.9', T0), true);
  assert.equal(consoleLoginThrottled('::1', T0), false);
  assert.equal(consoleLoginThrottled('fe80::1', T0), false, 'an IPv6 address is itself');
  assert.equal(_authThrottlePeersForTest(), 1, 'one entry for the host');
  noteConsoleLoginSuccess('10.0.0.9');
  assert.equal(consoleLoginThrottled('::ffff:10.0.0.9', T0), false, 'cleared under either form');
  assert.equal(_authThrottlePeersForTest(), 0);
});

test('throttle — the table holds at most AUTH_THROTTLE_MAX_PEERS addresses; the oldest entry goes first', () => {
  const addr = (p: number) => `10.${(p >> 16) & 255}.${(p >> 8) & 255}.${p & 255}`;
  for (let p = 0; p <= AUTH_THROTTLE_MAX_PEERS; p++) {
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) noteConsoleLoginFailure(addr(p), T0 + p);
  }
  assert.equal(_authThrottlePeersForTest(), AUTH_THROTTLE_MAX_PEERS);
  const now = T0 + AUTH_THROTTLE_MAX_PEERS;
  assert.equal(consoleLoginThrottled(addr(0), now), false, 'the first address was dropped');
  assert.equal(consoleLoginThrottled(addr(1), now), true, 'the second is kept');
  assert.equal(consoleLoginThrottled(addr(AUTH_THROTTLE_MAX_PEERS), now), true, 'the newest is kept');
  assert.equal(_authThrottlePeersForTest(), AUTH_THROTTLE_MAX_PEERS, 'the dropped address was not re-created by its check');
});

test('TuiSession — the login card counts under its peer: one address\'s ten failures leave another address admitted', () => {
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) assert.equal(submit(card('10.0.0.9'), 'x', 'y').quit, undefined, 'a first failure re-prompts');
  assert.equal(submit(card('10.0.0.9'), 'op', 'pw').quit, true, 'the address is refused with the right credentials');
  const other = card('10.0.0.10');
  assert.equal(submit(other, 'op', 'pw').redraw, true);
  assert.equal(other.isInteractive, true, 'another address logs in');
  assert.equal(consoleLoginThrottled('10.0.0.9'), true, 'the other address\'s login clears only its own address');
  // Sessions with no peer named share AUTH_PEER_UNKNOWN, apart from every address.
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) submit(card(), 'x', 'y');
  assert.equal(submit(card(), 'op', 'pw').quit, true);
  assert.equal(consoleLoginThrottled(AUTH_PEER_UNKNOWN), true);
  assert.equal(consoleLoginThrottled('10.0.0.11'), false);
  assert.equal(_authThrottlePeersForTest(), 2);
});

test('TuiSession — a login that succeeds clears its address: nine failures, a login, nine more, still admitted', () => {
  const nine = () => { for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) submit(card('10.0.0.9'), 'x', 'y'); };
  nine();
  const first = card('10.0.0.9');
  submit(first, 'op', 'pw');
  assert.equal(first.isInteractive, true);
  assert.equal(_authThrottlePeersForTest(), 0, 'the login cleared the address');
  nine(); // without the clear these are the address's 10th to 18th failures
  const second = card('10.0.0.9');
  assert.equal(submit(second, 'op', 'pw').quit, undefined);
  assert.equal(second.isInteractive, true, 'still admitted');
});
