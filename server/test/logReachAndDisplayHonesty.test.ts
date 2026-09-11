import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotStore, statusDumpLevel, STATUS_ANCHOR_MS, PERSISTING_FAILURE_HEARTBEAT_MS } from '../src/snapshot.js';

/**
 * v1.145.0 — forensic reach, and absence on the RENDER surface.
 *
 * The log ring reaches ~53 h. Bytes spent restating unchanged state are hours of
 * history not spent on an incident — which is not hypothetical here: an SHP2
 * question earlier in this project could not be settled because the window had
 * already rolled past it.
 */

const src = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../', rel), 'utf8');

// ── the fleet-status dump is a CHANGE log ────────────────────────────────────
/**
 * MEASURED over 53.1 h: 314 emissions, and once the per-device message counters
 * and the list age are normalised away, exactly ONE distinct body. Over a fifth
 * of the whole log, saying nothing.
 */
test('★ an unchanged fleet drops to debug', () => {
  assert.equal(
    statusDumpLevel({ signature: 'A', prevSignature: 'A', nowMs: 1_000, lastInfoMs: 1_000 }), 'debug');
});

test('★ a CHANGED fleet always reaches info, however recently one was emitted', () => {
  assert.equal(
    statusDumpLevel({ signature: 'B', prevSignature: 'A', nowMs: 1_001, lastInfoMs: 1_000 }), 'info',
    'a device changing state is the entire point of the dump');
});

test('the first dump of a process is always info', () => {
  assert.equal(
    statusDumpLevel({ signature: 'A', prevSignature: null, nowMs: 0, lastInfoMs: 0 }), 'info');
});

test('★ an hourly anchor still proves the fleet is being polled at all', () => {
  const base = { signature: 'A', prevSignature: 'A' as string | null, lastInfoMs: 0 };
  assert.equal(statusDumpLevel({ ...base, nowMs: STATUS_ANCHOR_MS - 1 }), 'debug');
  assert.equal(statusDumpLevel({ ...base, nowMs: STATUS_ANCHOR_MS }), 'info', 'boundary inclusive');
});

test('the standing-failure heartbeat is DAILY, not hourly', () => {
  // 48 lines in 53 h about a permanent, owner-settled product-class limit.
  assert.equal(PERSISTING_FAILURE_HEARTBEAT_MS, 24 * 60 * 60_000);
});

test('★ the signature excludes the counters that move every tick', () => {
  // Including them would make every dump a "change" — the trap this replaces.
  const s = src('src/snapshot.ts');
  const i = s.indexOf('const signature = parts.map');
  assert.ok(i > 0, 'the signature is built at the dump site');
  assert.match(s.slice(i, i + 200), /replace\(\/ON\\\/\\d\+msg/,
    'per-device message counters and ages must be normalised out of the signature');
});

// ── a device that DISAPPEARS from the list ───────────────────────────────────
const item = (sn: string, online: 0 | 1) =>
  ({ sn, deviceName: sn, productName: 'Delta Pro Ultra', online }) as never;

test('★ a device vanishing from /device/list leaves a breadcrumb, exactly once', () => {
  // It keeps its last `online` value forever with nothing logged, so "says online
  // but has been gone for hours" was indistinguishable from a healthy device.
  const lines: string[] = [];
  const store = new SnapshotStore();
  store.setLogger((m) => lines.push(m));
  store.setDeviceList([item('A', 1), item('B', 1)]);
  store.setDeviceList([item('A', 1)]);                       // B disappears
  store.setDeviceList([item('A', 1)]);                       // still gone
  const absent = lines.filter((l) => l.includes('ABSENT from /device/list'));
  assert.equal(absent.length, 1, 'once per disappearance, not once per poll');
  assert.match(absent[0], /\(B\)/);
  assert.match(absent[0], /state is now frozen, not refreshed/);
});

test('★ an absent device is NOT marked offline — that would invert a cloud glitch into an alarm', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('A', 1), item('B', 1)]);
  store.setDeviceList([item('A', 1)]);
  assert.equal(store.get().devices['B'].online, true,
    'the breadcrumb reports; it must not fabricate a device state change');
});

test('a device that returns re-arms the breadcrumb', () => {
  const lines: string[] = [];
  const store = new SnapshotStore();
  store.setLogger((m) => lines.push(m));
  store.setDeviceList([item('A', 1), item('B', 1)]);
  store.setDeviceList([item('A', 1)]);
  store.setDeviceList([item('A', 1), item('B', 1)]);
  store.setDeviceList([item('A', 1)]);
  assert.equal(lines.filter((l) => l.includes('ABSENT')).length, 2);
});

// ── absence on the render surface ────────────────────────────────────────────
/**
 * The same "absence is not success" family as v1.138.0–v1.144.0, one layer out.
 * A screen that paints an unknown green is making a claim the data does not
 * support, and it is the layer a human actually looks at.
 */
test('★ a pack that reported NOTHING does not render NORMAL', () => {
  // Every fault term is `x != null && <test>`, so an all-null pack scored false
  // on all three and came out green.
  const s = src('src/telnet/plant/gen.ts');
  assert.match(s, /const reported = pk\.temp != null \|\| pk\.minCellTemp != null \|\| pk\.soc != null;/);
  assert.match(s, /!reported \? 'NO DATA'/);
  assert.match(s, /!reported \? c\.grey/);
});

test('★ an ABSENT MPPT error code is not a confirmed zero', () => {
  // `(code ?? 0) === 0` collapsed "no error" and "no reading" into one green OK.
  const s = src('src/telnet/plant/pv.ts');
  assert.match(s, /if \(code == null\) return c\.grey\('—'\);/);
  assert.match(s, /if \(code === 0\) return c\.green\('OK'\);/);
  assert.ok(!/\(code \?\? 0\) === 0/.test(s), 'the nullish collapse must be gone');
});

test('★ the BUS screen shows staleness — it was the only Plant screen that did not', () => {
  // `qual` was computed and never rendered, while the header's liveness tick uses
  // snap.generatedAt, which advances whether or not the SHP2 answered.
  const s = src('src/telnet/plant/bus.ts');
  assert.match(s, /const qualTag = qual === 'good'/);
  assert.match(s, /\$\{qualTag\}/, 'and it must reach the rendered header');
});

test('the MQTT resubscribe dependency is pinned, not inherited', () => {
  // The app's own re-subscribe loop is dead on reconnect (`subscribed` is never
  // cleared on close), so correctness rests on the library default.
  assert.match(src('src/ecoflow/mqtt.ts'), /resubscribe: true,/);
});
