import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pushDebounceMsFor,
  MSG_RATE_PUSH_DEBOUNCE_MS,
  SETTLE_PUSH_DEBOUNCE_MS,
  DEBOUNCE_MS,
} from '../src/alertMonitor.js';
import { SnapshotStore } from '../src/snapshot.js';

/**
 * v1.143.0 — F2/F3/F4/F5 from the 2026-09-09 log audit.
 */

// ── F2: the starvation family gets a push dwell ──────────────────────────────
/**
 * MEASURED over 52.5 h: 50 pushes reached the phone and 42 (84%) were
 * msg-rate-floor — 25 episodes, 23 of them under 30 minutes, median 9.0 min,
 * shortest 15 seconds, every one self-clearing with no operator action possible.
 * v0.38.0 fixed this exact shape once already for the load-anomaly family.
 */
test('★ F2: the starvation family waits for the self-heal window before paging', () => {
  assert.equal(pushDebounceMsFor('msg-rate-floor-Y711ZAB59GBC0314'), MSG_RATE_PUSH_DEBOUNCE_MS);
  assert.equal(MSG_RATE_PUSH_DEBOUNCE_MS, 20 * 60_000,
    'aligned with sessionSelfHeal’s own starvation trigger — below it the system is still trying to fix itself');
});

test('F2: a 9-minute episode (the observed median) does not page; a 133-minute one does', () => {
  const dwell = pushDebounceMsFor('msg-rate-floor-SHP2');
  assert.ok(9 * 60_000 < dwell, 'the median episode is suppressed');
  assert.ok(133 * 60_000 >= dwell, 'the one that outlived the heal still pages');
});

test('F2: no other family is affected', () => {
  assert.equal(pushDebounceMsFor('vdiff-crit-SN-1'), Math.max(DEBOUNCE_MS, SETTLE_PUSH_DEBOUNCE_MS));
  assert.equal(pushDebounceMsFor('offline-SN'), DEBOUNCE_MS);
  assert.equal(pushDebounceMsFor('dpu-err-SN'), DEBOUNCE_MS);
  assert.equal(pushDebounceMsFor('shp2-below-reserve'), DEBOUNCE_MS);
});

test('★ F2: the prefix is EXACT — a 20-minute hold-down must not leak', () => {
  // The dwell is only defensible for a family that repairs itself within it.
  // Leaking onto a neighbour would silently delay a real page by 20 minutes,
  // which is a worse defect than the one this fixes.
  assert.equal(pushDebounceMsFor('msg-rate-floor-SN'), MSG_RATE_PUSH_DEBOUNCE_MS);
  for (const near of ['msg-rate-ceiling-SN', 'msg-rate-SN', 'msg-ratefloor-SN', 'msg-rate-floorless']) {
    assert.equal(pushDebounceMsFor(near), DEBOUNCE_MS, `${near} must not inherit the dwell`);
  }
});

test('F2: an explicit caller default still wins when it is LONGER', () => {
  // Math.max, not assignment — a caller that already demanded more keeps it.
  assert.equal(pushDebounceMsFor('msg-rate-floor-X', 60 * 60_000), 60 * 60_000);
});

// ── F4: the offline observation source is recorded ───────────────────────────
/**
 * Two home Cores went offline in the SAME cloud-list poll on 2026-09-09 14:40:23
 * and only one paged. The dwell was working: Core 5's /status had seen OFFLINE at
 * 14:39:59, 24 s earlier, so its clock had 69 s by dispatch; Core 1 ran 59 s
 * against a 60 s debounce. Correct behaviour on a one-second margin — but nothing
 * in the alert said which input started its clock.
 */
const item = (sn: string, online: 0 | 1) =>
  ({ sn, deviceName: sn, productName: sn.startsWith('SHP2') ? 'Smart Home Panel 2' : 'Delta Pro Ultra', online }) as never;

test('★ F4: the cloud-list path records itself as the observer', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('C1', 1)]);
  store.setDeviceList([item('C1', 0)]);
  const d = store.get().devices['C1'];
  assert.equal(d.onlineChangedVia, 'device-list');
  assert.ok((d.onlineChangedAtMs ?? 0) > 0);
});

test('★ F4: the /status path records itself, and it can fire FIRST', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('C5', 1)]);
  store.setDeviceOnline('C5', false);           // /status sees it 24 s early
  const d = store.get().devices['C5'];
  assert.equal(d.onlineChangedVia, 'status',
    'the earlier observer is the one that started the dispatch dwell');
});

test('F4: no structural asymmetry — two home Cores in ONE poll are recorded identically', () => {
  // The thing that would be a real defect: one of two simultaneous, identical
  // transitions being dropped. It is not — both are stamped by the same path in
  // the same tick, and any difference in outcome comes from the dwell clock.
  const store = new SnapshotStore();
  store.setDeviceList([item('C1', 1), item('C5', 1)]);
  store.setDeviceList([item('C1', 0), item('C5', 0)]);
  const a = store.get().devices['C1'];
  const b = store.get().devices['C5'];
  assert.equal(a.online, false);
  assert.equal(b.online, false);
  assert.equal(a.onlineChangedVia, b.onlineChangedVia);
  assert.ok(Math.abs((a.onlineChangedAtMs ?? 0) - (b.onlineChangedAtMs ?? 0)) < 50);
});

test('F4: a device that never changes state carries no stamp', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('C1', 1)]);
  assert.equal(store.get().devices['C1'].onlineChangedAtMs, undefined,
    'first sight is not a transition');
});

// ── F3 + F5: the observability fixes ─────────────────────────────────────────
const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

test('★ F5: the recorder heartbeat goes out on the DEBUG channel — as a PERIODIC SUMMARY', () => {
  // It was debug-GATED but info-EMITTED, so all 3,103 heartbeats in a 52 h window
  // carried level 30 — the same level as `battery-soc-alarm: crossed 20% (low)`.
  // pino's filter could never separate them, and `ha apps logs` returns 100 lines
  // of which 76 were heartbeats. v1.143.0 moved it to the debug channel.
  //
  // v1.150.0 — THE DEMOTION BOUGHT NOTHING, and this assertion is widened to say
  // why rather than being relaxed. `LOG_LEVEL=debug` is standing on the
  // deployment and pino writes every level to stdout, which the ring captures:
  // 1,274 of these lines sat in the live ring at `"level":20`. The line was
  // 3,084 of 5,965 ring lines (51.8%) and, once v1.148.0's poll fix landed,
  // 67.0% of what remained — costing roughly half the visible incident window.
  //
  // Level is not emission. The channel assertion is KEPT (it is still correct and
  // still worth pinning) and an emission-COUNT assertion is added beside it, so a
  // future refactor cannot quietly restore a per-minute line on the debug channel
  // and satisfy this test the way the old one-line version would have.
  const rec = src('recorder.ts');
  assert.match(rec, /debug\(\s*`recorder: \$\{recordedSamplesTotal\} samples over \$\{mins\} min`/,
    'the sample heartbeat must use the debug channel, not the info logger');
  assert.doesNotMatch(rec, /debug\(`recorder: \$\{recordedSamplesSinceTick\} samples in last/,
    'the PER-MINUTE line must be gone — demoting it again is not a fix, it was already at debug');
  assert.match(rec, /const SAMPLE_SUMMARY_EVERY = (\d+);/,
    'the emission count must be a NAMED constant so the cadence is inspectable');
  const every = Number(rec.match(/const SAMPLE_SUMMARY_EVERY = (\d+);/)![1]);
  assert.ok(every >= 10, `summary cadence ${every} must be a real reduction on ~60/h, not a token one`);
  // Pin the COMPARISON, not just the constant. A mutation that leaves
  // SAMPLE_SUMMARY_EVERY = 30 in place and changes the gate to `>= 1` restores
  // the per-minute line while every constant-valued assertion above still
  // passes — the mutation harness found exactly that survivor. The live branch
  // is what emits, so the live branch is what must be asserted.
  assert.match(rec, /if \(recordedSamplesWindows >= SAMPLE_SUMMARY_EVERY\) \{/,
    'the emission gate must compare against the NAMED constant, not an inline literal');
  // A quiet stretch must remain distinguishable from the summary not firing —
  // otherwise the fix reintroduces "absence is not success" at a lower rate.
  assert.match(rec, /min with activity/,
    'the summary must report how many windows had activity, so a total of 0 is legible');
  assert.ok(!/RECORDER_DEBUG\) \{\s*\n\s*log\(`recorder: \$\{recordedSamplesSinceTick\}/.test(rec),
    'and must not be re-gated on RECORDER_DEBUG through the info logger');
  assert.match(src('index.ts'), /createRecorder\(store, \(m\) => app\.log\.info\(m\), \(m\) => app\.log\.debug\(m\)\)/,
    'the production bridge must actually pass a debug callback');
});

test('★ F3: the boot orphan sweep logs its outcome even when it retires nothing', () => {
  // Across ten boots the sweep produced ZERO log lines, because the summary was
  // guarded on there being something to retire. A clean sweep and a sweep that
  // never ran were byte-identical — so v1.140.0's evidence gate could not be
  // shown to be reaching production at all.
  const mon = src('alertMonitor.ts');
  const i = mon.indexOf('orphanReconcileLogged');
  assert.ok(i > 0, 'the once-per-boot reconcile log flag exists');
  const block = mon.slice(mon.indexOf('if (resolve.length || drop.length) persistNotified();'));
  assert.match(block.slice(0, 900), /if \(!orphanReconcileLogged\)/,
    'the log must NOT be conditional on there being something to retire');
  assert.match(block.slice(0, 900), /boot reconcile — \$\{persistedNotified\.size\}/,
    'and must state how many records it actually examined');
});

// ── the sticky-clock rebuild (found while wiring F4) ─────────────────────────
/**
 * `setDeviceList` rebuilds the device object from an explicit literal on EVERY
 * poll — every 60 s — and silently drops any field not named in it. `lastErrorAt`
 * has been lost that way since v0.97.0 introduced it, and that field's entire
 * purpose was to stop a REST error resetting the staleness clock.
 *
 * Usually masked, because setDeviceQuota re-derives the quota clocks microseconds
 * later in the same poll. NOT masked when the quota fetch then FAILS — which is
 * precisely the state in which a frozen projection matters most.
 */
test('★ the 60 s device-list rebuild preserves every sticky clock', () => {
  const store = new SnapshotStore();
  store.setDeviceList([item('SHP2-1', 1)]);
  const dev = () => store.get().devices['SHP2-1'];

  store.setDeviceQuota('SHP2-1', { 'wattInfo.gridWatt': 100 });
  store.setDeviceError('SHP2-1', 'EcoFlow API error 1006');
  const before = {
    lastQuotaAtMs: dev().lastQuotaAtMs,
    lastErrorAt: dev().lastErrorAt,
    lastUpdated: dev().lastUpdated,
  };
  assert.ok(before.lastQuotaAtMs! > 0 && before.lastErrorAt! > 0, 'both clocks are set');

  store.setDeviceList([item('SHP2-1', 1)]); // the next poll, no state change

  assert.equal(dev().lastQuotaAtMs, before.lastQuotaAtMs, 'the quota clock survives the rebuild');
  assert.equal(dev().lastErrorAt, before.lastErrorAt, 'so does the v0.97.0 error clock');
  assert.equal(dev().lastUpdated, before.lastUpdated);
});

test('★ a content-stale flag is not wiped by the next poll', () => {
  // If it were, a shadowed panel would lose its guard every 60 s and the alarm
  // path would flap between honest-unknown and frozen-value.
  const store = new SnapshotStore();
  let t = 1_000_000;
  store.setClock(() => t);
  store.setDeviceList([item('SHP2-1', 1)]);
  const raw = {
    'loadInfo.hall1Watt': [0, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
    'wattInfo.gridWatt': 3914,
  } as Record<string, unknown>;
  for (let i = 0; i < 16; i++) { store.setDeviceQuota('SHP2-1', raw); t += 60_000; }
  assert.ok(store.get().devices['SHP2-1'].contentStaleSinceMs != null);

  store.setDeviceList([item('SHP2-1', 1)]);
  assert.ok(store.get().devices['SHP2-1'].contentStaleSinceMs != null,
    'the shadow guard must survive the device-list rebuild');
});
