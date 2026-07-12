import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { SPARE_DPU_SNS } from '../src/shp2Membership.js';
import { setDeviceReachability, type Reachability } from '../src/deviceLink.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.16.4 — cloud-offline alert gate for designated bench spares.
 *
 * Cores 4 + 5 are spares kept powered down and NOT wired into the SHP2,
 * so their EcoFlow-Cloud "offline" / stale-telemetry state is an expected
 * steady state — it must NOT chime / push / raise the broadcast condition.
 * The connectivity alert is still EMITTED (visible in the UI) but tagged
 * non-annunciating (annunciate:false) at info severity — "never hide an
 * active condition, only mute it."
 *
 * The single biggest landmine this pins down: the gate must NEVER mute a
 * REAL offline alarm for a genuine home core (1/2/3) — even one that is
 * faulted/unplugged and has dropped out of the SHP2's connected sources.
 * The SPARE_DPU_SNS allowlist is the safety floor: a home core is never in
 * it, so it can never be misclassified as a spare.
 * =================================================================== */

const [CORE4, CORE5] = [...SPARE_DPU_SNS]; // the two designated bench spares
const HOME_CORE_2 = 'Y711ZAB59GBC0482';    // a real home core SN (NOT a spare)
const now = Date.now();
const STALE_AGE = 5 * 60 * 1000;           // > STALE_MS (3 min)

// A complete-enough DPU projection so the online-device analysis loop in
// computeAlerts (pack imbalance, EMS window, MPPT, …) never throws on a
// missing field. Mirrors test/alertsMppt.ts's fixture; all values benign.
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

function dpu(over: Partial<DeviceSnapshot> & { sn: string }): DeviceSnapshot {
  return {
    deviceName: `Core ${over.sn.slice(-2)}`,
    productName: 'Delta Pro Ultra',
    online: true,
    lastUpdated: now,
    projection: { ...dpuProjection } as any,
    ...over,
  } as DeviceSnapshot;
}

function shp2(sources: Array<{ slot: number; sn?: string; isConnected: boolean }>): DeviceSnapshot {
  return {
    sn: 'SHP2_DUMMY',
    deviceName: 'Smart Home Panel 2',
    productName: 'Smart Home Panel 2',
    online: true,
    lastUpdated: now,
    projection: {
      kind: 'shp2',
      sources: sources.map((s) => ({ ...s, hwConnect: s.isConnected, errorCodeNum: 0 })),
      pairedCircuits: [],
    } as any,
  } as DeviceSnapshot;
}

function devices(...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> {
  const m: Record<string, DeviceSnapshot> = {};
  for (const d of arr) m[d.sn] = d;
  return m;
}

// v1.8.0 (review F2) — spares emit under their OWN family (`offline-spare-<SN>` /
// `stale-spare-<SN>`) so bench-spare churn can't poison the home devices'
// dispatch stats; the helpers accept both forms.
const offlineOf = (alerts: Alert[], sn: string) =>
  alerts.find((a) => a.id === `offline-${sn}` || a.id === `offline-spare-${sn}`);
const staleOf = (alerts: Alert[], sn: string) =>
  alerts.find((a) => a.id === `stale-${sn}` || a.id === `stale-spare-${sn}`);

/* ─── the mute path ─────────────────────────────────────────────── */

test('spare offline, no SHP2 yet (cold boot) → present but non-annunciating', () => {
  // Empty membership must STILL mute a KNOWN spare — we know it's a bench
  // core regardless of whether the SHP2 has been observed.
  const alerts = computeAlerts(devices(dpu({ sn: CORE4, online: false })));
  const a = offlineOf(alerts, CORE4);
  assert.ok(a, 'spare offline alert must still be EMITTED (mute-not-hide)');
  assert.equal(a!.annunciate, false, 'spare offline must be non-annunciating');
  assert.equal(a!.severity, 'info', 'an expected-offline spare is info, not warning');
});

test('spare offline, SHP2 present with cores 1/2/3 (spare not a source) → muted', () => {
  const alerts = computeAlerts(
    devices(
      shp2([
        { slot: 1, sn: 'CORE_1', isConnected: true },
        { slot: 2, sn: HOME_CORE_2, isConnected: true },
        { slot: 3, sn: 'CORE_3', isConnected: true },
      ]),
      dpu({ sn: CORE5, online: false }),
    ),
  );
  assert.equal(offlineOf(alerts, CORE5)?.annunciate, false);
});

test('spare cloud-online but telemetry idle (stale) → muted too (both channels gated)', () => {
  const alerts = computeAlerts(
    devices(dpu({ sn: CORE4, online: true, lastUpdated: now - STALE_AGE })),
  );
  const a = staleOf(alerts, CORE4);
  assert.ok(a, 'spare stale alert must still be emitted');
  assert.equal(a!.annunciate, false);
  assert.equal(a!.severity, 'info');
});

/* ─── the safety floor: a REAL home core must always annunciate ──── */

test('SAFETY: faulted home core (isConnected:false in SHP2) offline → STILL annunciates', () => {
  // Core 2 is provisioned but its SHP2 slot momentarily reports isConnected:false
  // (unplugged / faulted). It has therefore dropped out of the connected-source
  // set — but it is a genuine home core, so its real offline alarm MUST fire.
  // This is the exact mute-a-real-alarm regression the gate must never cause.
  const alerts = computeAlerts(
    devices(
      shp2([
        { slot: 1, sn: 'CORE_1', isConnected: true },
        { slot: 2, sn: HOME_CORE_2, isConnected: false }, // faulted
        { slot: 3, sn: 'CORE_3', isConnected: true },
      ]),
      dpu({ sn: HOME_CORE_2, online: false }),
    ),
  );
  const a = offlineOf(alerts, HOME_CORE_2);
  assert.ok(a, 'home core offline alert must be present');
  assert.notEqual(a!.annunciate, false, 'a real home core must NEVER be muted');
  assert.equal(a!.severity, 'warning', 'a real core-down is a warning');
});

test('home core offline with no SHP2 (cold boot) → annunciates (fail-safe)', () => {
  const alerts = computeAlerts(devices(dpu({ sn: HOME_CORE_2, online: false })));
  assert.notEqual(offlineOf(alerts, HOME_CORE_2)?.annunciate, false);
});

/* ─── the re-arm: a spare wired into the SHP2 starts alarming again ─ */

test('spare reporting as a CONNECTED source, then offline → annunciates (re-armed)', () => {
  // If Core 4 is wired into an SHP2 and reports as a connected source, it is no
  // longer an expected bench spare: a subsequent offline IS a real alarm.
  const alerts = computeAlerts(
    devices(
      shp2([{ slot: 1, sn: CORE4, isConnected: true }]),
      dpu({ sn: CORE4, online: false }),
    ),
  );
  assert.notEqual(offlineOf(alerts, CORE4)?.annunciate, false);
});

/* ─── v0.73.0: the offline alert is INVARIANT to LAN reachability ───
 *
 * The cloud-wedge-vs-real-outage feature (ECOFLOW_DEVICE_REACHABILITY +
 * setDeviceReachability) is purely ADDITIVE: it enriches an offline alert's
 * facts/hint text but must NEVER change the alert's id, severity, whether it
 * fires, or the spare-gating (annunciate:false). This is the load-bearing
 * safety property the v0.73.0 audit asked to pin down: the reachability cache
 * now has a TTL + validation, so prove that across getDeviceReachability() =
 * 'up' / 'down' / 'unknown' the alarm-relevant fields are byte-identical.
 * ───────────────────────────────────────────────────────────────── */

function withReachabilityEnv(map: Record<string, string>, fn: () => void): void {
  const prev = process.env.ECOFLOW_DEVICE_REACHABILITY;
  process.env.ECOFLOW_DEVICE_REACHABILITY = JSON.stringify(map);
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ECOFLOW_DEVICE_REACHABILITY;
    else process.env.ECOFLOW_DEVICE_REACHABILITY = prev;
  }
}

test('v0.73.0 — home-core offline alert is INVARIANT (id/severity/fires/annunciate) across reachability up/down/unknown', () => {
  // A valid entity_id so deviceReachabilityEntities() keeps it (post-validation).
  withReachabilityEnv({ [HOME_CORE_2]: 'binary_sensor.core2_lan' }, () => {
    const fleet = devices(
      shp2([
        { slot: 1, sn: 'CORE_1', isConnected: true },
        { slot: 2, sn: HOME_CORE_2, isConnected: true },
        { slot: 3, sn: 'CORE_3', isConnected: true },
      ]),
      dpu({ sn: HOME_CORE_2, online: false }),
    );
    for (const r of ['up', 'down', 'unknown'] as Reachability[]) {
      setDeviceReachability(HOME_CORE_2, r); // fresh ts → within the TTL
      const a = offlineOf(computeAlerts(fleet), HOME_CORE_2);
      assert.ok(a, `home-core offline alert must STILL fire with reachability=${r}`);
      assert.equal(a!.id, `offline-${HOME_CORE_2}`, `id unchanged (${r})`);
      assert.equal(a!.severity, 'warning', `severity stays warning for a home core (${r})`);
      assert.notEqual(a!.annunciate, false, `home core must NEVER be muted (${r})`);
    }
  });
});

test('v0.73.0 — spare offline alert keeps id/info-severity/annunciate:false across reachability up/down/unknown', () => {
  withReachabilityEnv({ [CORE4]: 'binary_sensor.core4_lan' }, () => {
    // Spare not wired into the SHP2 → expected-offline steady state, muted.
    const fleet = devices(
      shp2([{ slot: 1, sn: 'CORE_1', isConnected: true }]),
      dpu({ sn: CORE4, online: false }),
    );
    for (const r of ['up', 'down', 'unknown'] as Reachability[]) {
      setDeviceReachability(CORE4, r);
      const a = offlineOf(computeAlerts(fleet), CORE4);
      assert.ok(a, `spare offline alert must still be EMITTED with reachability=${r}`);
      // v1.8.0 (review F2) — spares now emit under their own family id.
      assert.equal(a!.id, `offline-spare-${CORE4}`, `id stable across reachability states (${r})`);
      assert.equal(a!.severity, 'info', `spare stays info (${r})`);
      assert.equal(a!.annunciate, false, `spare stays non-annunciating (${r})`);
    }
  });
});

test('v0.73.0 — reachability ONLY enriches: it adds a LAN-reachability fact but the alarm fields are unchanged vs the unconfigured baseline', () => {
  const fleet = devices(
    shp2([
      { slot: 1, sn: 'CORE_1', isConnected: true },
      { slot: 2, sn: HOME_CORE_2, isConnected: true },
      { slot: 3, sn: 'CORE_3', isConnected: true },
    ]),
    dpu({ sn: HOME_CORE_2, online: false }),
  );
  // Baseline: feature dormant (unconfigured) → no LAN fact.
  const prev = process.env.ECOFLOW_DEVICE_REACHABILITY;
  delete process.env.ECOFLOW_DEVICE_REACHABILITY;
  let base: Alert | undefined;
  try {
    base = offlineOf(computeAlerts(fleet), HOME_CORE_2);
  } finally {
    if (prev !== undefined) process.env.ECOFLOW_DEVICE_REACHABILITY = prev;
  }
  assert.ok(base);
  assert.ok(!base!.facts?.some((f) => f.label === 'LAN reachability'), 'dormant feature adds no LAN fact');

  // Configured + reachable-up → adds a "cloud session wedged" LAN fact, but id /
  // severity / annunciate are identical to the dormant baseline.
  withReachabilityEnv({ [HOME_CORE_2]: 'binary_sensor.core2_lan' }, () => {
    setDeviceReachability(HOME_CORE_2, 'up');
    const enriched = offlineOf(computeAlerts(fleet), HOME_CORE_2);
    assert.ok(enriched);
    assert.equal(enriched!.id, base!.id);
    assert.equal(enriched!.severity, base!.severity);
    assert.equal(enriched!.annunciate, base!.annunciate);
    assert.ok(enriched!.facts?.some((f) => f.label === 'LAN reachability'), 'configured feature adds the LAN-reachability fact (the only difference)');
  });
});

/* ─── the system-wide cloud-session-stale alert is SN-agnostic ───── */

test('cloud-session-stale is untouched by the spare gate', () => {
  const alerts = computeAlerts(
    devices(dpu({ sn: CORE4, online: false })),
    {
      lastDeviceListSuccessAt: now - 10 * 60 * 1000, // 10 min ago → stale session
      lastDeviceListAttemptAt: now,
      perDevice: new Map(),
    } as any,
  );
  const sys = alerts.find((a) => a.id === 'cloud-session-stale');
  assert.ok(sys, 'account-wide cloud-session-stale must always fire');
  assert.notEqual(sys!.annunciate, false, 'a genuine account-wide condition annunciates');
});
