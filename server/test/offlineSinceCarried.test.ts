/**
 * v1.187.10 — the offline hint carries how long the device was already listed offline before the
 * restart, from the add-on's persisted record.
 *
 * The v1.187.1 wording for a device with no data this session took its age from
 * SnapshotStore.firstListedAt, which is per process: five hours after the 2026-10-03 12:08 restart
 * the Smart Generator, WAVE 2 and a DELTA 3 Plus read "listed it offline since the add-on's first
 * device list (5 h ago); how long before that, and why, is not known here", while
 * /api/repair-issues had them first seen offline 104, 104 and 89 days earlier
 * (repair-first-seen.json). That record is now kept by the alert monitor on every evaluation —
 * stamped on the first offline listing, cleared only by an ONLINE listing, persisted on either
 * change — and the hint reads it when it predates this process: "listed it offline since at least
 * 104 d ago (first seen offline before the add-on's last restart, and not seen online since)".
 * (The alert-onset sidecar is not used: it drops entries older than 7 days at load.)
 * Id, severity, priority and annunciation are unchanged. Test serials are placeholders.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const DAY = 86_400_000;
const WAVE = 'WAVEXXX00XXX0001';
const GEN = 'GENEXXX00XXX0001';
const SPARE_LIKE = 'COREXXX00XXX0009';

const tmp = mkdtempSync(join(tmpdir(), 'ef-offline-since-'));
const FIRST_SEEN = join(tmp, 'repair-first-seen.json');
// The record from before "the restart": WAVE first seen offline 104 days ago.
const SEEDED_AT = Date.now() - 104 * DAY;
writeFileSync(FIRST_SEEN, JSON.stringify({ [`cloud-offline-${WAVE}`]: SEEDED_AT, 'wash-panels': Date.now() - DAY }));
process.env.REPAIR_FIRST_SEEN_PATH = FIRST_SEEN;
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(tmp, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(tmp, 'latch.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const repair = await import('../src/repairIssues.js');
const { computeAlerts } = await import('../src/alerts.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const persisted = (): Record<string, number> => (existsSync(FIRST_SEEN) ? JSON.parse(readFileSync(FIRST_SEEN, 'utf8')) : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

/* ── the hint ──────────────────────────────────────────────────────────── */

const dev = (sn: string, over: Partial<DeviceSnapshot> = {}) =>
  ({ sn, deviceName: 'WAVE 2', productName: 'WAVE 2', online: false, lastUpdated: 0, ...over } as DeviceSnapshot);
const hint = (offlineSinceMs: number | null, firstListedAtMs: number | null) => {
  const now = Date.now();
  return computeAlerts({ [WAVE]: dev(WAVE) }, {
    lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now,
    perDevice: new Map([[WAVE, { mqttCount: 0, firstListedAtMs, offlineSinceMs }]]),
  }).find((a) => a.id === `offline-${WAVE}`)!;
};

test('★★★ a stamp from before this process: "since at least 104 d ago", not "since the add-on\'s first device list"', () => {
  const a = hint(Date.now() - 104 * DAY, Date.now() - 5 * 3_600_000);
  assert.match(a.detail, /EcoFlow Cloud has listed it offline since at least 104 d ago \(first seen offline before the add-on's last restart, and not seen online since\); why is not known here\. If the device is meant to be on, check its power and its Wi-Fi\.$/, a.detail);
  assert.doesNotMatch(a.detail, /first device list|how long before that/);
  assert.equal(a.severity, 'info', 'unchanged');
  assert.equal(a.priority, 'low', 'unchanged');
  assert.equal(a.annunciate, undefined, 'unchanged');
});

test('★★ a stamp taken in THIS process (at or after its first listing) says nothing new: the v1.187.1 wording stands', () => {
  const listed = Date.now() - 5 * 3_600_000;
  assert.match(hint(listed, listed).detail, /since the add-on's first device list \(5 h ago\); how long before that, and why, is not known here\./);
  assert.match(hint(listed + 60_000, listed).detail, /since the add-on's first device list/);
  assert.match(hint(null, listed).detail, /since the add-on's first device list/);
});

test('★ no listing time but a stamp: the stamp is used', () => {
  assert.match(hint(Date.now() - 3 * DAY, null).detail, /since at least 3 d ago/);
});

/* ── the record ────────────────────────────────────────────────────────── */

test('★★★ the record survives a restart (loaded from the sidecar at boot)', () => {
  assert.equal(repair.cloudOfflineFirstSeenAt(WAVE), SEEDED_AT);
});

test('★★★ stamped on the first offline listing, kept while offline or ABSENT, cleared only by an ONLINE listing — persisted each change', () => {
  const t0 = Date.now();
  repair.syncCloudOfflineFirstSeen({ [GEN]: { sn: GEN, online: false } }, t0);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), t0);
  assert.equal(persisted()[`cloud-offline-${GEN}`], t0, 'persisted');
  repair.syncCloudOfflineFirstSeen({ [GEN]: { sn: GEN, online: false } }, t0 + 60_000);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), t0, 'never restamped while offline');
  repair.syncCloudOfflineFirstSeen({}, t0 + 120_000);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), t0, 'absence from a list is no evidence the outage ended');
  repair.syncCloudOfflineFirstSeen({ [GEN]: { sn: GEN } }, t0 + 150_000);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), t0, 'an unknown online flag is no evidence either');
  repair.syncCloudOfflineFirstSeen({ [GEN]: { sn: GEN, online: true } }, t0 + 180_000);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), null, 'listed online: cleared');
  assert.equal(persisted()[`cloud-offline-${GEN}`], undefined, 'and the clear is persisted — a restart cannot bring the old stamp back');
  repair.syncCloudOfflineFirstSeen({ [GEN]: { sn: GEN, online: false } }, t0 + 240_000);
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), t0 + 240_000, 'the next outage starts fresh');
});

test('★★ the repair fetch never clears a cloud-offline stamp on absence — only an online listing does', () => {
  const ctx = (devices: Record<string, unknown>) => ({ devices: devices as never, alerts: [], degradation: null, soiling: null, equipmentHealth: null, forecastSkill: null });
  repair.computeRepairIssues(ctx({}));
  assert.equal(repair.cloudOfflineFirstSeenAt(WAVE), SEEDED_AT, 'a fetch on an empty (boot) map keeps it');
  const listed = { sn: GEN, deviceName: 'Generator', productName: 'Smart Generator', online: false, lastUpdated: 0 };
  const kept = repair.cloudOfflineFirstSeenAt(GEN);
  assert.ok(kept != null, 'precondition: the previous test left GEN stamped');
  const card = repair.computeRepairIssues(ctx({ [GEN]: listed })).issues.find((i) => i.id === `cloud-offline-${GEN}`)!;
  assert.equal(card.firstSeenAt, kept, 'the card reports the stamp the monitor keeps');
  repair.computeRepairIssues(ctx({ [GEN]: { ...listed, online: true } }));
  assert.equal(repair.cloudOfflineFirstSeenAt(GEN), null, 'listed online at a fetch: cleared');
  assert.equal(persisted()[`cloud-offline-${GEN}`], undefined, 'and persisted');
});

test('a bench spare is never stamped (its offline state is expected, as the repair card skips it)', async () => {
  const { setLastKnownHomeRoster } = await import('../src/shp2Membership.js');
  setLastKnownHomeRoster(null);
  const { benchSpareSns } = await import('../src/shp2Membership.js');
  const spare = benchSpareSns()[0];
  assert.ok(spare != null, 'precondition: the safety-floor literal names a bench spare');
  repair.syncCloudOfflineFirstSeen({ [spare]: { sn: spare, online: false }, [SPARE_LIKE]: { sn: SPARE_LIKE, online: false } });
  assert.equal(repair.cloudOfflineFirstSeenAt(spare), null);
  assert.ok(repair.cloudOfflineFirstSeenAt(SPARE_LIKE) != null, 'a non-spare is');
});

/* ── through the real alert monitor ────────────────────────────────────── */

test('★★★ end to end: the monitor reads the persisted stamp into the hint, and an online listing clears it on disk', { timeout: 30_000 }, async () => {
  repair.resetRepairFirstSeenForTesting();
  repair.reloadRepairFirstSeenForTesting(); // as at boot: WAVE's stamp is back from the sidecar if still on disk
  if (repair.cloudOfflineFirstSeenAt(WAVE) == null) {
    writeFileSync(FIRST_SEEN, JSON.stringify({ ...persisted(), [`cloud-offline-${WAVE}`]: SEEDED_AT }));
    repair.reloadRepairFirstSeenForTesting();
  }
  const store = new SnapshotStore();
  store.setDeviceList([{ sn: WAVE, deviceName: 'WAVE 2', productName: 'WAVE 2', online: 0 } as never]);
  store.markFirstPollSettled();
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), () => {}, {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async () => {}) as any,
  });
  const onScreen = (id: string) => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id === id);
  try {
    await until(() => onScreen(`offline-${WAVE}`) != null, 5_000, 'the offline alert');
    assert.match(onScreen(`offline-${WAVE}`)!.detail, /listed it offline since at least 104 d ago \(first seen offline before the add-on's last restart/);
    // The device comes back: the next evaluation clears the stamp, on disk too.
    (store.get().devices as Record<string, DeviceSnapshot>)[WAVE].online = true;
    await until(() => persisted()[`cloud-offline-${WAVE}`] == null, 5_000, 'the persisted clear');
    assert.equal(repair.cloudOfflineFirstSeenAt(WAVE), null);
  } finally {
    mon.stop();
  }
});
