/**
 * v1.8.0 — engine-review fixes F3 + F2.
 *
 * F3 (reserve chain blind during SHP2 cloud wedges): the 30-day ground-truth
 * review found two fleet-cloud blackouts (42.2h, 25.8h) in which the SHP2's
 * backupBatPercent read null while the pool physically crossed 50/40/30/20% —
 * every reserve classifier sat dark for 17.8–20.8h. Two fixes under test:
 *   (a) homeFleetMeanSoc() — the SoC-ladder fallback source (mean SoC of the
 *       home Cores still reporting; the backup pool IS those batteries).
 *   (b) the 'reserve-alarm-blind' compensating alert in computeAlerts —
 *       warning after 15 min of sustained pool-unreadability, escalating to
 *       critical after 60 min while the grid is NOT backstopping.
 *
 * F2 (auto-silencer severity-blind one-way latch): the 'offline' family latched
 * downgradedSilenced on 06-04 from bench-spare churn and then silently dropped
 * 134 real home-Core/SHP2 offline warnings. Three fixes under test:
 *   (a) spares roll up under their own 'offline-spare' / 'stale-spare' families,
 *   (b) the wedge-signal families are exempt from auto-tune,
 *   (c) applySilencingRules RE-DERIVES flags each evaluation instead of
 *       one-way latching, so exemptions and severity re-classification shed a
 *       stale latch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { homeFleetMeanSoc } from '../src/shp2Membership.js';
import { applySilencingRules, ENERGY_STATE_FAMILIES, type AlertActionStats } from '../src/alertMonitor.js';
import { familyOf } from '../src/alertOutcomes.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const now = Date.now();
const MIN = 60 * 1000;

/* ── fixtures ──────────────────────────────────────────────────────────── */

const dpuProjection = {
  kind: 'dpu',
  soc: 95,
  packs: [],
  pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
  pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
  pvHighErrCode: 0, pvLowErrCode: 0,
  acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
  batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
  splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
  sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
  chgMaxSoc: 100, dsgMinSoc: 10,
};

function dpu(sn: string, soc: number, online = true): DeviceSnapshot {
  return {
    sn, deviceName: `Core ${sn.slice(-2)}`, productName: 'Delta Pro Ultra',
    online, lastUpdated: now,
    projection: { ...dpuProjection, soc } as any,
  } as DeviceSnapshot;
}

function shp2(opts: { pool: number | null; online?: boolean; lastUpdated?: number }): DeviceSnapshot {
  return {
    sn: 'HD31ZASAHH120432', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
    online: opts.online ?? true, lastUpdated: opts.lastUpdated ?? now,
    projection: { kind: 'shp2', backupBatPercent: opts.pool, backupReserveSoc: 15, sources: [], pairedCircuits: [] } as any,
  } as DeviceSnapshot;
}

const devices = (...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> =>
  Object.fromEntries(arr.map((d) => [d.sn, d]));

/** Connectivity context with a healthy cloud session + a pool-unknown onset. */
function conn(backupPoolUnknownSinceMs: number | null) {
  return {
    lastDeviceListAttemptAt: now,
    lastDeviceListSuccessAt: now,
    perDevice: new Map(),
    backupPoolUnknownSinceMs,
  };
}

const blind = (a: Alert[]) => a.find((x) => x.id === 'reserve-alarm-blind');

// Home Cores (real SNs); Core 4 is a designated bench spare.
const CORE1 = 'Y711ZAB59GBC0314';
const CORE2 = 'Y711ZAB59GBC0482';
const SPARE4 = 'Y711ZABA9H3T0489';

/* ── F3(a): homeFleetMeanSoc ───────────────────────────────────────────── */

test('homeFleetMeanSoc — mean of ONLINE home Cores; spares and offline Cores excluded', () => {
  const d = devices(
    dpu(CORE1, 40),
    dpu(CORE2, 60),
    dpu(SPARE4, 100),        // spare: excluded even though online
    dpu('Y711FAB59J234000', 90, false), // offline home Core: excluded (stale soc)
  );
  assert.equal(homeFleetMeanSoc(d), 50);
});

test('homeFleetMeanSoc — null when NO home Core is reporting (never fabricates)', () => {
  const d = devices(dpu(CORE1, 40, false), dpu(SPARE4, 100));
  assert.equal(homeFleetMeanSoc(d), null);
});

/* ── F3(b): reserve-alarm-blind compensating alert ─────────────────────── */

test('reserve-alarm-blind — absent while the pool is readable', () => {
  const alerts = computeAlerts(devices(shp2({ pool: 55 }), dpu(CORE1, 55)), conn(null));
  assert.equal(blind(alerts), undefined);
});

test('reserve-alarm-blind — absent under the 15-min debounce (reconnect blips never fire it)', () => {
  const alerts = computeAlerts(
    devices(shp2({ pool: null }), dpu(CORE1, 55)),
    conn(now - 5 * MIN),
  );
  assert.equal(blind(alerts), undefined);
});

test('reserve-alarm-blind — WARNING after 15 min of pool-null, carrying the fallback-ladder SoC', () => {
  const alerts = computeAlerts(
    devices(shp2({ pool: null }), dpu(CORE1, 40), dpu(CORE2, 60)),
    conn(now - 20 * MIN),
  );
  const a = blind(alerts);
  assert.ok(a, 'fires after sustained blindness');
  assert.equal(a!.severity, 'warning');
  assert.match(a!.detail, /Core-fleet fallback \(mean 50%/, 'tells the operator the ladder is on the DPU fallback');
});

test('reserve-alarm-blind — escalates to CRITICAL after 60 min while the grid is NOT backstopping', () => {
  const alerts = computeAlerts(
    devices(shp2({ pool: null }), dpu(CORE1, 40)),
    conn(now - 90 * MIN),
    { backstopping: false },
  );
  const a = blind(alerts);
  assert.ok(a);
  assert.equal(a!.severity, 'critical', 'off-grid + long-blind is the dangerous conjunction');
});

test('reserve-alarm-blind — stays WARNING when the grid is backstopping (low pool would transfer to mains)', () => {
  const alerts = computeAlerts(
    devices(shp2({ pool: null }), dpu(CORE1, 40)),
    conn(now - 90 * MIN),
    { backstopping: true },
  );
  const a = blind(alerts);
  assert.ok(a);
  assert.equal(a!.severity, 'warning');
});

test('reserve-alarm-blind — frozen-value path: SHP2 cloud-OFFLINE with a stale non-null pool also counts as blind', () => {
  // Cloud says offline ⇒ the projection (incl. pool %) is a frozen last-known
  // value, not live truth. Blind since lastUpdated.
  const alerts = computeAlerts(
    devices(shp2({ pool: 42, online: false, lastUpdated: now - 30 * MIN }), dpu(CORE1, 42)),
    conn(null),
  );
  const a = blind(alerts);
  assert.ok(a, 'frozen-value blindness fires too');
  assert.equal(a!.severity, 'warning');
});

test('reserve-alarm-blind — says so plainly when NO Core is reporting either (fully dark)', () => {
  const alerts = computeAlerts(
    devices(shp2({ pool: null }), dpu(CORE1, 40, false)),
    conn(now - 20 * MIN),
  );
  const a = blind(alerts);
  assert.ok(a);
  assert.match(a!.detail, /fully dark/, 'never fabricates a fallback number');
});

/* ── F2(a): spare family split ─────────────────────────────────────────── */

test('familyOf — spare offline/stale alerts roll up under their OWN families', () => {
  assert.equal(familyOf(`offline-${CORE1}`), 'offline');
  assert.equal(familyOf(`offline-spare-${SPARE4}`), 'offline-spare');
  assert.equal(familyOf(`stale-${CORE1}`), 'stale');
  assert.equal(familyOf(`stale-spare-${SPARE4}`), 'stale-spare');
});

/* ── F2(b): wedge-signal families exempt from auto-tune ────────────────── */

test('ENERGY_STATE_FAMILIES — the wedge-signal + compensating families are exempt', () => {
  for (const fam of ['offline', 'stale', 'forecast-soc-dip', 'reserve-alarm-blind']) {
    assert.ok(ENERGY_STATE_FAMILIES.has(fam), `${fam} must be exempt from auto-tune`);
  }
  // The spare families are deliberately NOT exempt — spare churn may still be tuned away.
  assert.ok(!ENERGY_STATE_FAMILIES.has('offline-spare'));
  assert.ok(!ENERGY_STATE_FAMILIES.has('stale-spare'));
});

/* ── F2(c): re-derive instead of one-way latch ─────────────────────────── */

function stats(over: Partial<AlertActionStats>): AlertActionStats {
  return {
    familyKey: 'fam', alertId: 'fam-x', title: 'Fam', severity: 'warning', category: 'Battery',
    riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
    downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
    neverClearedCount: 0, lastSeenAt: null,
    ...over,
  };
}

test('re-derive — a newly-exempted family sheds a STALE latch on the next evaluation', () => {
  // The live instance's 'offline' family latched on 06-04; after the exemption
  // ships, the very next evaluation must clear it.
  const t = stats({
    familyKey: 'offline', severity: 'warning',
    riseCount: 500, shortClearsCount: 450, neverClearedCount: 10,
    downgradedSilenced: true, warningDemotedToInfo: true, chronicNoiseSilenced: true, // stale latch
  });
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, false);
  assert.equal(t.warningDemotedToInfo, false);
  assert.equal(t.chronicNoiseSilenced, false);
});

test('re-derive — an info-tier latch clears when the family re-classifies to warning', () => {
  // Rule 1 trips while the exemplar is info…
  const t = stats({ familyKey: 'peer-widget', severity: 'info', riseCount: 6, shortClearsCount: 5 });
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, true, 'precondition: info-tier latch set');
  // …then a WARNING member fires (exemplar severity updates) with counters below
  // every warning-tier rule: the info latch must NOT keep eating warnings.
  t.severity = 'warning';
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, false, 'severity-blind latch is gone');
  assert.equal(t.warningDemotedToInfo, false);
});

test('re-derive — a latch whose conditions STILL hold is unchanged (rules are pure functions of the counters)', () => {
  const t = stats({ familyKey: 'peer-widget', severity: 'info', riseCount: 10, shortClearsCount: 9 });
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, true);
  applySilencingRules(t); // idempotent re-evaluation
  assert.equal(t.downgradedSilenced, true, 're-deriving never weakens a live latch');
});
