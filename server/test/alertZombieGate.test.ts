import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { SPARE_DPU_SNS } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.16.4 — Zombie-alert gate for designated bench spares.
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

const offlineOf = (alerts: Alert[], sn: string) => alerts.find((a) => a.id === `offline-${sn}`);
const staleOf = (alerts: Alert[], sn: string) => alerts.find((a) => a.id === `stale-${sn}`);

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
