/**
 * reconnectAudit.ts — v1.90.0 (register B5). The long-offline reconnect
 * transition audit, automated.
 *
 * Core 2 has been cloud-dark since early August and returns ~Sept 1. Every
 * prior review flagged the same follow-up: when it comes back, audit the
 * transition — online flip → first telemetry → offline-alert resolution →
 * pack sanity → the PV-coverage restoration the blind-spot fix predicts.
 * Waiting for a human (or a scheduled log review) to notice the flip loses
 * the transition window; this module watches for it and runs the audit
 * automatically, delivering ONE report push per reconnect.
 *
 * DISCIPLINE
 *  - Pure decision core over injected snapshots; the driver only feeds and
 *    dispatches. ARMS only after >= ARM_OFFLINE_MS continuously offline (a
 *    presence flap must not fire an audit — Core 2 flapped on 08-13).
 *  - The audit collects checkpoints for AUDIT_WINDOW_MS after the flip and
 *    then reports once: flip time, first-telemetry latency, offline-alert
 *    resolution, pack table vs siblings, and pvCoverage before/after.
 *  - Offline tenure survives restarts via a tiny sidecar (a deploy during the
 *    wait must not reset the 24 h arming clock).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';

export const ARM_OFFLINE_MS = 24 * 60 * 60 * 1000;
export const AUDIT_WINDOW_MS = 30 * 60 * 1000;

export interface DeviceObs {
  sn: string;
  name: string;
  kind: 'dpu' | 'shp2' | 'other';
  online: boolean;
  lastUpdatedMs: number; // 0 = never in this process
  packs?: Array<{ num: number; socPct: number | null; spreadMv: number | null }>;
}

export interface ReconnectWatchState {
  /** SN -> when continuous offline began (persisted). */
  offlineSinceMs: Record<string, number>;
  /** SNs whose >=24h arming was already logged (one line per offline episode). */
  armedLogged: Record<string, boolean>;
  /** An audit in flight, one at a time (reconnects are rare events). */
  audit: {
    sn: string;
    name: string;
    armedOfflineForMs: number;
    onlineAtMs: number;
    firstTelemetryMs: number | null;
    offlineAlertResolvedMs: number | null;
    pvCoverageAtFlip: number | null;
    packsAt10Min: DeviceObs['packs'] | null;
  } | null;
}

export function freshReconnectWatchState(): ReconnectWatchState {
  return { offlineSinceMs: {}, armedLogged: {}, audit: null };
}

/* ─── tenure sidecar: a deploy during the 24h wait must not reset the clock ── */

const SIDECAR = () =>
  process.env.RECONNECT_WATCH_STATE_PATH
    ?? resolve(process.cwd(), config.dbPath, '..', 'reconnect-watch.json');

export function loadReconnectWatchState(): ReconnectWatchState {
  const fresh = freshReconnectWatchState();
  try {
    if (!existsSync(SIDECAR())) return fresh;
    const raw = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    if (raw?.offlineSinceMs && typeof raw.offlineSinceMs === 'object') {
      for (const [sn, t] of Object.entries(raw.offlineSinceMs)) {
        if (typeof t === 'number' && Number.isFinite(t)) fresh.offlineSinceMs[sn] = t;
      }
    }
    if (raw?.armedLogged && typeof raw.armedLogged === 'object') {
      for (const [sn, v] of Object.entries(raw.armedLogged)) {
        if (v === true) fresh.armedLogged[sn] = true;
      }
    }
    return fresh; // an in-flight audit deliberately does NOT survive a restart
  } catch {
    return fresh;
  }
}

export function saveReconnectWatchState(state: ReconnectWatchState): void {
  try {
    atomicWriteFileSync(SIDECAR(), JSON.stringify({
      offlineSinceMs: state.offlineSinceMs, armedLogged: state.armedLogged,
    }));
  } catch { /* best-effort */ }
}

export type ReconnectEvent =
  | { kind: 'none' }
  | { kind: 'armed'; sn: string; name: string; offlineForMs: number }
  | { kind: 'auditStarted'; sn: string; name: string; offlineForMs: number }
  | { kind: 'report'; report: ReconnectReport };

export interface ReconnectReport {
  sn: string;
  name: string;
  offlineForMs: number;
  onlineAtMs: number;
  firstTelemetryLatencyMs: number | null; // null = still none by window end
  offlineAlertResolvedAfterMs: number | null;
  packs: DeviceObs['packs'] | null;
  pvCoverageAtFlip: number | null;
  pvCoverageAtReport: number | null;
}

/**
 * One evaluation tick. MUTATES `state`. `offlineAlertActive` = whether the
 * `offline-<sn>` alert is still in the live alert set; `pvCoverage` = current
 * fleet PV coverage (the blind-spot restoration signal).
 */
export function evaluateReconnectWatch(
  state: ReconnectWatchState,
  devices: ReadonlyArray<DeviceObs>,
  offlineAlertActiveBySn: ReadonlySet<string>,
  pvCoverage: number | null,
  nowMs: number,
): ReconnectEvent {
  // Track offline tenure for every DPU (only DPUs get audits; the SHP2 going
  // dark is a different, louder problem with its own alarms).
  let event: ReconnectEvent = { kind: 'none' };
  for (const d of devices) {
    if (d.kind !== 'dpu') continue;
    const since = state.offlineSinceMs[d.sn];
    if (!d.online) {
      if (since == null) {
        state.offlineSinceMs[d.sn] = nowMs;
      } else if (event.kind === 'none' && nowMs - since >= ARM_OFFLINE_MS && !state.armedLogged[d.sn]) {
        state.armedLogged[d.sn] = true;
        event = { kind: 'armed', sn: d.sn, name: d.name, offlineForMs: nowMs - since };
      }
      continue;
    }
    // ONLINE. A reconnect after arming starts the audit; a short flap clears tenure.
    if (since != null) {
      const offlineFor = nowMs - since;
      delete state.offlineSinceMs[d.sn];
      delete state.armedLogged[d.sn];
      if (offlineFor >= ARM_OFFLINE_MS && state.audit == null) {
        state.audit = {
          sn: d.sn, name: d.name, armedOfflineForMs: offlineFor, onlineAtMs: nowMs,
          firstTelemetryMs: null, offlineAlertResolvedMs: null,
          pvCoverageAtFlip: pvCoverage, packsAt10Min: null,
        };
        return { kind: 'auditStarted', sn: d.sn, name: d.name, offlineForMs: offlineFor };
      }
    }
  }

  // Advance an in-flight audit.
  const a = state.audit;
  if (a != null) {
    const dev = devices.find((d) => d.sn === a.sn);
    if (a.firstTelemetryMs == null && dev != null && dev.lastUpdatedMs > a.onlineAtMs) {
      a.firstTelemetryMs = dev.lastUpdatedMs;
    }
    if (a.offlineAlertResolvedMs == null && !offlineAlertActiveBySn.has(a.sn)) {
      a.offlineAlertResolvedMs = nowMs;
    }
    if (a.packsAt10Min == null && nowMs - a.onlineAtMs >= 10 * 60_000 && dev?.packs?.length) {
      a.packsAt10Min = dev.packs;
    }
    if (nowMs - a.onlineAtMs >= AUDIT_WINDOW_MS) {
      state.audit = null;
      return {
        kind: 'report',
        report: {
          sn: a.sn, name: a.name, offlineForMs: a.armedOfflineForMs, onlineAtMs: a.onlineAtMs,
          firstTelemetryLatencyMs: a.firstTelemetryMs != null ? a.firstTelemetryMs - a.onlineAtMs : null,
          offlineAlertResolvedAfterMs: a.offlineAlertResolvedMs != null ? a.offlineAlertResolvedMs - a.onlineAtMs : null,
          packs: a.packsAt10Min ?? (dev?.packs ?? null),
          pvCoverageAtFlip: a.pvCoverageAtFlip,
          pvCoverageAtReport: pvCoverage,
        },
      };
    }
  }
  return event;
}

/** Render the report push body. Pure. */
export function renderReconnectReport(r: ReconnectReport): { title: string; body: string } {
  const days = (r.offlineForMs / 86_400_000).toFixed(1);
  const lat = r.firstTelemetryLatencyMs != null ? `${Math.round(r.firstTelemetryLatencyMs / 1000)}s` : 'NONE within the 30-min window';
  const res = r.offlineAlertResolvedAfterMs != null ? `${Math.round(r.offlineAlertResolvedAfterMs / 1000)}s after the flip` : 'NOT resolved within the window';
  const packs = r.packs?.length
    ? r.packs.map((p) => `pack ${p.num}: ${p.socPct ?? '?'}%${p.spreadMv != null ? ` (${p.spreadMv} mV spread)` : ''}`).join('; ')
    : 'no pack telemetry captured';
  const cov = r.pvCoverageAtFlip != null && r.pvCoverageAtReport != null
    ? `PV coverage ${(r.pvCoverageAtFlip * 100).toFixed(0)}% → ${(r.pvCoverageAtReport * 100).toFixed(0)}%`
    : 'PV coverage change unavailable';
  return {
    title: `${r.name} is back — reconnect audit`,
    body:
      `${r.name} reconnected after ${days} days offline. First telemetry: ${lat}. `
      + `Offline alert resolved: ${res}. Packs: ${packs}. ${cov}. `
      + 'If this is Core 2: expect local solar to rise ~20 kWh/day and the ledger solar drift to collapse — the blind-spot prediction is now testable.',
  };
}
