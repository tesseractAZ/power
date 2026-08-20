import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateReconnectWatch, freshReconnectWatchState, renderReconnectReport,
  loadReconnectWatchState, saveReconnectWatchState,
  ARM_OFFLINE_MS, AUDIT_WINDOW_MS, type DeviceObs, type ReconnectWatchState,
} from '../src/reconnectAudit.js';

/**
 * v1.90.0 (B5) — the Core 2 reconnect auto-audit. The invariants under test:
 * a presence FLAP must never fire an audit (Core 2 flapped on 08-13 and the
 * fleet must not page on it), arming happens exactly once per >=24h episode,
 * and the audit delivers ONE report carrying the transition checkpoints.
 */

const T0 = Date.UTC(2026, 7, 15, 12, 0);
const HOUR = 3_600_000;

function dpu(over: Partial<DeviceObs> = {}): DeviceObs {
  return { sn: 'CORE2SN', name: 'Core 2', kind: 'dpu', online: false, lastUpdatedMs: 0, ...over };
}

const NO_ALERTS: ReadonlySet<string> = new Set();

test('a presence flap (offline < 24h, then back) NEVER starts an audit', () => {
  const st = freshReconnectWatchState();
  // Offline for 23h — tracked, never armed.
  for (let h = 0; h < 23; h++) {
    const ev = evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0 + h * HOUR);
    assert.equal(ev.kind, 'none', `no event at hour ${h}`);
  }
  // Back online at 23h: tenure clears silently, no audit, and the NEXT
  // offline episode starts its own fresh 24h clock.
  const back = evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: T0 + 23 * HOUR })], NO_ALERTS, null, T0 + 23 * HOUR);
  assert.equal(back.kind, 'none');
  assert.equal(st.audit, null);
  assert.equal(st.offlineSinceMs['CORE2SN'], undefined);
  const again = evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0 + 24 * HOUR);
  assert.equal(again.kind, 'none');
  assert.equal(st.offlineSinceMs['CORE2SN'], T0 + 24 * HOUR, 'fresh episode, fresh clock');
});

test('arming fires exactly ONCE per episode, at >=24h continuous offline', () => {
  const st = freshReconnectWatchState();
  evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0);
  const armed = evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0 + ARM_OFFLINE_MS);
  assert.equal(armed.kind, 'armed');
  // Subsequent offline ticks stay silent — one log line per episode.
  const later = evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0 + ARM_OFFLINE_MS + HOUR);
  assert.equal(later.kind, 'none');
});

test('only DPUs are watched — the SHP2 going dark is a different alarm', () => {
  const st = freshReconnectWatchState();
  const shp2: DeviceObs = { sn: 'HD31SN', name: 'Panel', kind: 'shp2', online: false, lastUpdatedMs: 0 };
  evaluateReconnectWatch(st, [shp2], NO_ALERTS, null, T0);
  assert.equal(st.offlineSinceMs['HD31SN'], undefined);
});

test('full audit lifecycle: flip -> telemetry -> alert resolve -> packs -> ONE report', () => {
  const st = freshReconnectWatchState();
  evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0);
  const flipAt = T0 + 26 * HOUR;
  const offlineAlert = new Set(['CORE2SN']);

  const started = evaluateReconnectWatch(st, [dpu({ online: true })], offlineAlert, 0.667, flipAt);
  assert.equal(started.kind, 'auditStarted');
  assert.equal(st.audit?.pvCoverageAtFlip, 0.667);

  // +2 min: first telemetry lands (lastUpdated after the flip), alert still up.
  evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: flipAt + 2 * 60_000 })], offlineAlert, 0.667, flipAt + 3 * 60_000);
  assert.equal(st.audit?.firstTelemetryMs, flipAt + 2 * 60_000);

  // +5 min: the offline-<sn> alert resolves.
  evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: flipAt + 2 * 60_000 })], NO_ALERTS, 0.7, flipAt + 5 * 60_000);
  assert.equal(st.audit?.offlineAlertResolvedMs, flipAt + 5 * 60_000);

  // +12 min: pack table snapshot.
  const packs = [{ num: 1, socPct: 44, spreadMv: 38 }];
  evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: flipAt + 11 * 60_000, packs })], NO_ALERTS, 0.8, flipAt + 12 * 60_000);
  assert.deepEqual(st.audit?.packsAt10Min, packs);

  // +30 min: the ONE report, then the audit is gone.
  const rep = evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: flipAt + 11 * 60_000, packs })], NO_ALERTS, 0.92, flipAt + AUDIT_WINDOW_MS);
  assert.equal(rep.kind, 'report');
  if (rep.kind !== 'report') throw new Error('unreachable');
  assert.equal(rep.report.firstTelemetryLatencyMs, 2 * 60_000);
  assert.equal(rep.report.offlineAlertResolvedAfterMs, 5 * 60_000);
  assert.equal(rep.report.pvCoverageAtFlip, 0.667);
  assert.equal(rep.report.pvCoverageAtReport, 0.92);
  assert.equal(rep.report.offlineForMs, 26 * HOUR);
  assert.equal(st.audit, null);
  const after = evaluateReconnectWatch(st, [dpu({ online: true, lastUpdatedMs: flipAt + 11 * 60_000 })], NO_ALERTS, 0.92, flipAt + AUDIT_WINDOW_MS + HOUR);
  assert.equal(after.kind, 'none', 'exactly one report per reconnect');
});

test('a silent reconnect (no telemetry, alert stuck) reports the ABSENCE honestly', () => {
  const st = freshReconnectWatchState();
  evaluateReconnectWatch(st, [dpu()], NO_ALERTS, null, T0);
  const flipAt = T0 + 25 * HOUR;
  const stuck = new Set(['CORE2SN']);
  evaluateReconnectWatch(st, [dpu({ online: true })], stuck, null, flipAt);
  const rep = evaluateReconnectWatch(st, [dpu({ online: true })], stuck, null, flipAt + AUDIT_WINDOW_MS);
  assert.equal(rep.kind, 'report');
  if (rep.kind !== 'report') throw new Error('unreachable');
  assert.equal(rep.report.firstTelemetryLatencyMs, null);
  assert.equal(rep.report.offlineAlertResolvedAfterMs, null);
  const msg = renderReconnectReport(rep.report);
  assert.match(msg.body, /NONE within the 30-min window/);
  assert.match(msg.body, /NOT resolved within the window/);
});

test('sidecar roundtrip: tenure + armed flags survive, an in-flight audit does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reconnect-'));
  process.env.RECONNECT_WATCH_STATE_PATH = join(dir, 'reconnect-watch.json');
  try {
    const st: ReconnectWatchState = freshReconnectWatchState();
    st.offlineSinceMs['CORE2SN'] = T0;
    st.armedLogged['CORE2SN'] = true;
    st.audit = {
      sn: 'CORE2SN', name: 'Core 2', armedOfflineForMs: 25 * HOUR, onlineAtMs: T0 + 25 * HOUR,
      firstTelemetryMs: null, offlineAlertResolvedMs: null, pvCoverageAtFlip: null, packsAt10Min: null,
    };
    saveReconnectWatchState(st);
    const loaded = loadReconnectWatchState();
    assert.equal(loaded.offlineSinceMs['CORE2SN'], T0, 'a deploy must not reset the 24h clock');
    assert.equal(loaded.armedLogged['CORE2SN'], true);
    assert.equal(loaded.audit, null, 'an audit does not survive a restart by design');
  } finally {
    delete process.env.RECONNECT_WATCH_STATE_PATH;
  }
});

test('report render names the Core 2 blind-spot prediction', () => {
  const msg = renderReconnectReport({
    sn: 'CORE2SN', name: 'Core 2', offlineForMs: 26 * 86_400_000, onlineAtMs: T0,
    firstTelemetryLatencyMs: 95_000, offlineAlertResolvedAfterMs: 240_000,
    packs: [{ num: 1, socPct: 44, spreadMv: 38 }, { num: 2, socPct: 46, spreadMv: null }],
    pvCoverageAtFlip: 0.667, pvCoverageAtReport: 1,
  });
  assert.match(msg.title, /Core 2 is back/);
  assert.match(msg.body, /26\.0 days offline/);
  assert.match(msg.body, /First telemetry: 95s/);
  assert.match(msg.body, /pack 1: 44% \(38 mV spread\)/);
  assert.match(msg.body, /pack 2: 46%/);
  assert.match(msg.body, /PV coverage 67% → 100%/);
  assert.match(msg.body, /~20 kWh\/day/);
});
