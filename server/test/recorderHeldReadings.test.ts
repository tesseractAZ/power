/**
 * v1.188.1 — the recorder writes a device's projection only while its content is FRESH.
 *
 * After the 2026-10-14 internet outage (23:53 → 01:55) every Core stayed "offline" in the EcoFlow
 * cloud device list for about 20 h and the panel came back at 04:16. The store keeps a device's
 * last projection across `/device/list` polls and fetches quota only for a device listed online,
 * so each Core's projection was its reading from before the outage — and the recorder's 5-minute
 * heartbeat restated every metric of it at the current time: ~1,300 rows per Core per hour with
 * nothing changing, PV 0 W while the pool charged on solar. Those rows also stamped the per-device
 * gap clock, so the 6 h sweep built for a silent device never fired.
 *
 * Driven through a real SnapshotStore and createRecorder (its 'change' subscription), on mocked
 * wall and monotonic clocks, with fake serials.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');

const { createRecorder, cleanShutdownWasGraceful, inProcessDeviceDarkMs } = await import('../src/recorder.js');
const { projectionRecordable, heldSinceMs, RECORD_FRESH_MS, HELD_SPAN_MIN_MS } = await import('../src/heldSamples.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { computeAlerts, outageAlerts } = await import('../src/alerts.js');

const MIN = 60_000;
const H = 60 * MIN;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);

const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003', 'COREXXX00XXX0004', 'COREXXX00XXX0005'];
const PANEL = 'PANEXXX00XXX0001';
const listItem = (sn: string, online: boolean) => ({
  sn, deviceName: sn === PANEL ? 'Smart Home Panel 2' : `Core ${CORES.indexOf(sn) + 1}`,
  productName: sn === PANEL ? 'Smart Home Panel 2' : 'Delta Pro Ultra', online: online ? 1 : 0,
}) as any;
/** A Core's REST quota; `k` moves every value, as a live Core's readings move. */
const coreQuota = (k: number) => ({
  'hs_yj751_pd_appshow_addr.soc': 40 + (k % 50),
  'hs_yj751_pd_appshow_addr.wattsOutSum': 900 + k,
  'hs_yj751_pd_appshow_addr.wattsInSum': 300 + k,
  'hs_yj751_pd_appshow_addr.outAc5p8Pwr': 850 + k,
  'hs_yj751_pd_backend_addr.batVol': 51 + (k % 7) / 10,
  'hs_yj751_pd_backend_addr.mpptHvTemp': 30 + (k % 5),
  'hs_yj751_pd_backend_addr.mpptLvTemp': 28 + (k % 4),
  'hs_yj751_pd_backend_addr.inHvMpptPwr': 0,
  'hs_yj751_pd_app_set_info_addr.chgMaxSoc': 100,
});
const panelQuota = (k: number) => ({
  'loadInfo.hall1Watt': [k % 300, 134 + k, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
  'wattInfo.gridWatt': 0,
});

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { c, advance: (ms: number) => { c.wall += ms; c.mono += ms; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

function resetDb() {
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
  if (existsSync(join(tmp, '.clean-shutdown'))) unlinkSync(join(tmp, '.clean-shutdown'));
  if (!existsSync(DB_PATH)) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('DELETE FROM samples');
    try { db.exec('DELETE FROM held_spans; DELETE FROM held_samples; DELETE FROM held_scan;'); } catch { /* first boot creates them */ }
  } finally { db.close(); }
}
function rows(sql: string, ...p: Array<string | number>): any[] {
  const db = new DatabaseSync(DB_PATH);
  try { return db.prepare(sql).all(...p) as any[]; } finally { db.close(); }
}
const countRows = (sn: string, fromMs: number, toMs: number) =>
  Number(rows('SELECT COUNT(*) AS n FROM samples WHERE sn = ? AND ts > ? AND ts <= ?', sn, fromMs, toMs)[0].n);

/* ══ the predicate ══════════════════════════════════════════════════════════ */

test('projectionRecordable — fresh content only; the boundary, a clock step, a missing clock, a replayed shadow', () => {
  const now = 10_000_000;
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now }, now), true, 'content that just landed');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now - RECORD_FRESH_MS }, now), true, '★ exactly the window is still fresh');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now - RECORD_FRESH_MS - 1 }, now), false, '★ one ms past it is held');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now + RECORD_FRESH_MS + 1 }, now), false, '★ a content clock ahead by more than the window (a clock step) is not a reading');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now + RECORD_FRESH_MS }, now), true);
  assert.equal(projectionRecordable({}, now), false, '★★ no content clock: not a reading (fail-closed)');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: 0 }, now), false);
  assert.equal(projectionRecordable({ lastTelemetryAtMs: Number.NaN }, now), false);
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now, contentStaleSinceMs: now - 5 * MIN }, now), false, '★★ a latched cloud shadow is a replayed body');
  assert.equal(projectionRecordable({ lastTelemetryAtMs: now, contentStaleSinceMs: null }, now), true, 'a released latch records');
  assert.equal(RECORD_FRESH_MS, 3 * MIN, 'three missed 60 s polls, the stale alarm\'s own figure — and under the 5-min heartbeat');
  assert.equal(heldSinceMs({ lastTelemetryAtMs: 500, contentStaleSinceMs: 300 }), 300, 'the shadow onset when it is earlier');
  assert.equal(heldSinceMs({ lastTelemetryAtMs: 500 }), 500);
  assert.equal(heldSinceMs({}), null);
});

/* ══ the incident ═══════════════════════════════════════════════════════════ */

test('★★★ the 2026-10-14 incident: held Cores write nothing, the panel keeps recording, the gaps are ledgered, the alarms are untouched', async (t) => {
  resetDb();
  const T0 = phx(2026, 10, 14, 23, 0);
  const { c, advance } = clocks(t, T0);
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const lines: string[] = [];
  const rec = createRecorder(store, (m) => lines.push(m));
  try {
    const all = [...CORES, PANEL];
    let k = 0;
    const poll = async (online: Set<string>) => {
      store.setDeviceList(all.map((sn) => listItem(sn, online.has(sn))));
      await flush();
      for (const sn of all) {
        if (!online.has(sn)) continue; // refreshAll fetches quota only for a device listed online
        store.setDeviceQuota(sn, sn === PANEL ? panelQuota(k) : coreQuota(k));
        await flush();
      }
      k++;
    };
    // 23:00 → 23:53: everything online and live.
    while (c.wall < phx(2026, 10, 14, 23, 53)) { await poll(new Set(all)); advance(MIN); }
    const lastFresh = c.wall - MIN;
    for (const sn of all) assert.ok(countRows(sn, T0 - 1, lastFresh) > 0, `precondition: ${sn} recorded while live`);
    // 23:53 → 01:55: the internet is down — listDevices throws before setDeviceList, MQTT is down: no events.
    advance(phx(2026, 10, 15, 1, 55) - c.wall);
    // 01:55 → 04:16: the list polls again, every device listed OFFLINE.
    while (c.wall < phx(2026, 10, 15, 4, 16)) { await poll(new Set()); advance(MIN); }
    const panelBack = c.wall;
    // 04:16 → 10:30: the panel is back; the Cores stay offline.
    while (c.wall < phx(2026, 10, 15, 6, 30)) { await poll(new Set([PANEL])); advance(MIN); }
    // v1.188.1 (review) — 6 h 37 min after each Core's last fresh sample, but 4 h 23 min of that
    // (23:53 → 04:16) every home device was dark: that is the fleet gap's, not a Core's. A Core is
    // charged only with time another home device wrote, so none is filed yet.
    assert.deepEqual(rec.telemetryGaps().filter((g) => g.sn != null), [],
      '★★★ not filed at 05:53: the fleet-wide hours count toward no device');
    while (c.wall < phx(2026, 10, 15, 10, 30)) { await poll(new Set([PANEL])); advance(MIN); }

    // The alarm still sees every Core offline: it reads the store, which the recorder never changed.
    const devices = store.get().devices;
    const before = JSON.stringify(devices);
    const alerts = computeAlerts(devices);
    for (const sn of CORES) {
      assert.ok(alerts.some((a) => a.id === `offline-${sn}` && a.severity === 'warning'), `★★★ offline-${sn} still fires`);
      assert.ok(devices[sn].projection, 'the held projection is still in the store for the alarms to read');
    }
    rec.insertSnapshot(store.get());
    assert.equal(JSON.stringify(store.get().devices), before, '★★ the recorder does not touch the alarm inputs');
    assert.deepEqual(computeAlerts(store.get().devices).map((a) => a.id), alerts.map((a) => a.id), 'same snapshot, same alerts');

    for (const sn of CORES) {
      assert.equal(countRows(sn, lastFresh + RECORD_FRESH_MS, c.wall), 0,
        `★★★ ${sn}: zero rows while its reading is held (pre-fix: ~${'1,300'}/h from 01:55)`);
    }
    assert.equal(countRows(PANEL, lastFresh + RECORD_FRESH_MS, panelBack - 1), 0, '★★★ the panel wrote nothing while it was held');
    assert.ok(countRows(PANEL, panelBack - 1, c.wall) > 100, '★★ the panel records again from its first fresh reading');

    const gaps = rec.telemetryGaps();
    const fleet = gaps.filter((g) => g.sn == null);
    assert.equal(fleet.length, 1, JSON.stringify(gaps));
    assert.ok(Math.abs(fleet[0].startMs - lastFresh) < MIN && Math.abs(fleet[0].endMs - panelBack) < MIN,
      `★★ the fleet gap runs to the first FRESH home write (04:16), not to 01:55: ${new Date(fleet[0].startMs).toISOString()} → ${new Date(fleet[0].endMs).toISOString()}`);
    for (const sn of CORES) {
      const d = gaps.filter((g) => g.sn === sn);
      assert.equal(d.length, 1, `★★★ ${sn}: the per-device sweep now sees the held Core (one record): ${JSON.stringify(d)}`);
      assert.ok(Math.abs(d[0].startMs - lastFresh) < MIN, 'from its last fresh sample');
      assert.ok(Math.abs(d[0].endMs - (panelBack + 6 * H)) <= 2 * MIN,
        `★★ filed once it had been dark 6 h while the panel wrote (≈ 10:16), not 6 h after it went quiet: ${new Date(d[0].endMs).toISOString()}`);
    }
    const oa = outageAlerts(gaps, c.wall, { recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN, enabled: true });
    assert.equal(oa.filter((a) => a.id.startsWith('system-outage-device-') && a.id.endsWith('-3')).length, CORES.length, oa.map((a) => a.id).join(' '));
    assert.equal(oa.filter((a) => /^system-outage-\d+-2$/.test(a.id)).length, 1, 'one fleet record, 1-6 h tier');
    assert.ok(oa.every((a) => a.severity === 'warning'), 'retrospective warnings');

    // The held-span log: each hold of an hour or more, from its last fresh content.
    const spans = rec.heldSpans!(T0, c.wall);
    for (const sn of CORES) {
      const s = spans.filter((x) => x.sn === sn);
      assert.equal(s.length, 1, `${sn} has one held span: ${JSON.stringify(spans)}`);
      assert.equal(s[0].reason, 'gate-stale');
      assert.ok(Math.abs(s[0].startMs - lastFresh) < MIN, 'starts at its last fresh content');
      assert.ok(c.wall - s[0].endMs <= 2 * MIN, 'and is current');
    }
    const ps = spans.filter((x) => x.sn === PANEL);
    assert.equal(ps.length, 1);
    assert.ok(Math.abs(ps[0].endMs - panelBack) <= 2 * MIN, 'the panel span closed when it came back');
    assert.ok(lines.some((l) => l.includes(`${CORES[0]} has delivered no fresh readings since`)), 'logged once per hold');

    // A Core that comes back resumes on its first fresh update.
    const backAt = c.wall;
    store.setDeviceList(all.map((sn) => listItem(sn, sn === PANEL || sn === CORES[0])));
    store.setDeviceQuota(CORES[0], coreQuota(k + 1000));
    await flush();
    assert.ok(countRows(CORES[0], backAt - 1, backAt) >= 5, '★★★ every metric is written at the first fresh reading');
    store.setDeviceQuota(PANEL, panelQuota(k + 1));
    await flush();
    assert.ok(lines.some((l) => l.includes(`${CORES[0]} is reporting again after`)), 'the hold is closed and logged');
  } finally {
    rec.close();
  }
});

/* ══ v1.188.1 review: a fleet-wide silence is no one device's darkness ══════════ */

test('inProcessDeviceDarkMs — the time since the last sample in which another home device could report', () => {
  assert.equal(inProcessDeviceDarkMs(0, 7 * H), 7 * H, 'no fleet-dark window: all of it');
  assert.equal(inProcessDeviceDarkMs(0, 7 * H, [{ startMs: 0, endMs: 7 * H }]), 0, '★★ the whole silence was fleet-wide');
  assert.equal(inProcessDeviceDarkMs(H, 10 * H, [{ startMs: 0, endMs: 3 * H }]), 7 * H, 'only the part after its last sample counts');
  assert.equal(inProcessDeviceDarkMs(0, 10 * H, [{ startMs: H, endMs: 3 * H }, { startMs: 2 * H, endMs: 4 * H }]), 7 * H, 'overlapping windows count once');
  assert.equal(inProcessDeviceDarkMs(5 * H, 4 * H), 0, 'never negative');
});

async function fleetOutage(t: TestContext, outageMs: number, coresLagMs: number) {
  resetDb();
  const { c, advance } = clocks(t, phx(2026, 10, 16, 6, 0));
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const rec = createRecorder(store, () => {});
  const cores = CORES.slice(0, 3);
  const all = [PANEL, ...cores];
  let k = 0;
  // The poll refreshAll makes: the list, then each quota in its own I/O callback (a Promise.all of
  // separate HTTP calls), so each device's content lands in its own recorder batch.
  const poll = async (sns: readonly string[]) => {
    store.setDeviceList(all.map((sn) => listItem(sn, true)));
    await flush();
    for (const sn of sns) { store.setDeviceQuota(sn, sn === PANEL ? panelQuota(k) : coreQuota(k)); await flush(); }
    k++;
  };
  for (let i = 0; i < 30; i++) { await poll(all); advance(MIN); }
  const before = rec.telemetryGaps().length;
  advance(outageMs); // the internet is down: no list, no quota, no MQTT
  if (coresLagMs > 0) {
    await poll([PANEL]); // the panel answers first …
    advance(coresLagMs);
    await poll(all);     // … the Cores a few minutes later
  } else {
    await poll(all);
  }
  for (let i = 0; i < 10; i++) { advance(MIN); await poll(all); }
  const gaps = rec.telemetryGaps().slice(before);
  return { rec, gaps, c };
}

test('★★★ a fleet-wide outage of more than 6 h files the fleet gap only, though the devices answer one by one', async (t) => {
  const { rec, gaps } = await fleetOutage(t, 7 * H, 0);
  try {
    assert.deepEqual(gaps.filter((g) => g.sn != null).map((g) => g.sn), [],
      '★★★ v1.188.1 before review: three "Device telemetry gap — no data for 421 min" WARNINGs, every Core having answered in the same poll');
    const fleet = gaps.filter((g) => g.sn == null);
    assert.equal(fleet.length, 1);
    assert.ok(Math.abs(fleet[0].durationMs - 7 * H) <= 2 * MIN, `the outage is the fleet's: ${fleet[0].durationMs / MIN} min`);
    const oa = outageAlerts(gaps, Date.now(), { recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN, enabled: true });
    assert.equal(oa.filter((a) => a.id.startsWith('system-outage-device-')).length, 0, oa.map((a) => a.title).join(' | '));
  } finally { rec.close(); }
});

test('★★ devices that come back minutes after the first are charged with those minutes only', async (t) => {
  const { rec, gaps } = await fleetOutage(t, 7 * H, 4 * MIN);
  try {
    assert.deepEqual(gaps.filter((g) => g.sn != null), [], 'four minutes while the panel wrote is not six hours');
    assert.equal(gaps.filter((g) => g.sn == null).length, 1);
  } finally { rec.close(); }
});

/* ══ what is, and is not, fresh content ═════════════════════════════════════ */

async function liveCore(t: TestContext) {
  resetDb();
  const { c, advance } = clocks(t, phx(2026, 10, 16, 12, 0));
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const rec = createRecorder(store, () => {});
  const sn = CORES[0];
  store.setDeviceList([listItem(sn, true), listItem(PANEL, true)]);
  store.setDeviceQuota(sn, coreQuota(1));
  store.setDeviceQuota(PANEL, panelQuota(1));
  await flush();
  return { c, advance, store, rec, sn };
}

test('★★ a Core the cloud lists OFFLINE whose MQTT deltas keep arriving keeps recording (the key is content, not `online`)', async (t) => {
  const { c, advance, store, rec, sn } = await liveCore(t);
  try {
    store.setDeviceList([listItem(sn, false), listItem(PANEL, true)]);
    await flush();
    const from = c.wall;
    for (let i = 0; i < 20; i++) {
      advance(MIN);
      store.mergeDeviceQuota(sn, { 'hs_yj751_pd_appshow_addr.wattsOutSum': 1_000 + 37 * i }, 'mqtt');
      await flush();
    }
    assert.ok(countRows(sn, from, c.wall) >= 20, 'every MQTT delta is a reading and is written');
  } finally { rec.close(); }
});

test('★★ a /status ONLINE flip on a held device is not content: it stays unrecorded', async (t) => {
  const { c, advance, store, rec, sn } = await liveCore(t);
  try {
    store.setDeviceList([listItem(sn, false), listItem(PANEL, true)]);
    await flush();
    advance(RECORD_FRESH_MS + MIN);
    const from = c.wall;
    store.setDeviceOnline(sn, true); // bumps lastUpdated, never lastTelemetryAtMs
    await flush();
    for (let i = 0; i < 12; i++) { advance(MIN); store.setDeviceQuota(PANEL, panelQuota(10 + i)); await flush(); }
    assert.equal(countRows(sn, from - 1, c.wall), 0, 'the flip vouches for nothing; the 5-min heartbeat restates nothing');
    assert.ok(countRows(PANEL, from, c.wall) > 0);
  } finally { rec.close(); }
});

test('★ REST failing with no MQTT: written while within the window, then held', async (t) => {
  const { c, advance, store, rec, sn } = await liveCore(t);
  try {
    const last = c.wall;
    for (let i = 0; i < 15; i++) {
      advance(MIN);
      store.setDeviceError(sn, 'getQuotaAll ETIMEDOUT');
      store.setDeviceQuota(PANEL, panelQuota(20 + i));
      await flush();
    }
    assert.equal(countRows(sn, last, c.wall), 0,
      '★★ not one restatement: inside the window no metric moved and no heartbeat was due, and the window ends before the 5-min heartbeat');
  } finally { rec.close(); }
});

test('★★ a panel under the cloud-shadow latch records nothing; once released, it records', async (t) => {
  resetDb();
  const { c, advance } = clocks(t, phx(2026, 10, 16, 13, 0));
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const rec = createRecorder(store, () => {});
  try {
    store.setDeviceList([listItem(PANEL, true)]);
    const frozen = panelQuota(7);
    for (let i = 0; i < 16; i++) { store.setDeviceQuota(PANEL, frozen); await flush(); advance(MIN); }
    const dev = store.get().devices[PANEL];
    assert.ok(dev.contentStaleSinceMs != null, 'precondition: the replayed payload latched');
    const latchedAt = c.wall;
    for (let i = 0; i < 10; i++) { store.setDeviceQuota(PANEL, frozen); await flush(); advance(MIN); }
    assert.equal(countRows(PANEL, latchedAt - 1, c.wall), 0, '★★ a replayed body is not written, though every REST 200 bumps lastTelemetryAtMs');
    for (let k = 1; k <= 6; k++) { store.setDeviceQuota(PANEL, panelQuota(100 + k)); await flush(); advance(MIN); }
    assert.equal(store.get().devices[PANEL].contentStaleSinceMs, null, 'precondition: released');
    const releasedAt = c.wall;
    store.setDeviceQuota(PANEL, panelQuota(200));
    await flush();
    assert.ok(countRows(PANEL, releasedAt - 1, c.wall) > 0, 'moving again: recorded');
  } finally { rec.close(); }
});

/* ══ the restart probe ══════════════════════════════════════════════════════ */

test('cleanShutdownWasGraceful — one-sided: a marker after the last fresh sample is deliberate', () => {
  const anchor = 1_000_000_000;
  assert.equal(cleanShutdownWasGraceful(anchor + 2 * H, anchor), true, '★★ stopped deliberately 2 h after the fleet went quiet');
  assert.equal(cleanShutdownWasGraceful(anchor, anchor), true);
  assert.equal(cleanShutdownWasGraceful(anchor - 5 * MIN, anchor), true, 'within a heartbeat before');
  assert.equal(cleanShutdownWasGraceful(anchor - 5 * MIN - 1, anchor), false, '★ an older marker predates the anchor');
  assert.equal(cleanShutdownWasGraceful(null, anchor), false, 'no marker: not deliberate');
  assert.equal(cleanShutdownWasGraceful(anchor, null), false);
});

test('★★ a deploy made 2 h into a fleet-wide hold is an add-on restart, not a power outage', (t) => {
  resetDb();
  const T = phx(2026, 10, 15, 3, 0);
  clocks(t, T);
  const anchor = T - 2 * H - 30 * MIN; // the newest FRESH home sample: the gate wrote nothing after it
  const db = new DatabaseSync(DB_PATH);
  try { db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)').run(anchor, PANEL, 'panel_load', 1200); } finally { db.close(); }
  writeFileSync(join(tmp, '.clean-shutdown'), String(T - 30 * MIN)); // stopped 2 h after it, deliberately
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const g = rec.telemetryGaps().filter((x) => x.restartSpanning);
    assert.equal(g.length, 1);
    assert.equal(g[0].startMs, anchor);
    assert.equal(g[0].graceful, true, '★★ the two-sided v1.14.0 test read this as "the Pi lost power"');
  } finally { rec.close(); }
});

test('★ a gate span shorter than an hour is not logged', async (t) => {
  const { advance, store, rec, sn } = await liveCore(t);
  try {
    store.setDeviceList([listItem(sn, false), listItem(PANEL, true)]);
    for (let i = 0; i < 50; i++) { advance(MIN); store.setDeviceQuota(PANEL, panelQuota(300 + i)); await flush(); }
    assert.deepEqual(rec.heldSpans!(0, Date.now() + H).filter((s) => s.sn === sn), [], 'under an hour: not a held span');
    for (let i = 0; i < 15; i++) { advance(MIN); store.setDeviceQuota(PANEL, panelQuota(400 + i)); await flush(); }
    const s = rec.heldSpans!(0, Date.now() + H).filter((x) => x.sn === sn);
    assert.equal(s.length, 1, 'past an hour: logged');
    assert.ok(s[0].endMs - s[0].startMs >= HELD_SPAN_MIN_MS);
  } finally { rec.close(); }
});
