import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import { activeSocBand, socAlertSeverity } from './batterySocAlarm.js';
import { shp2ConnectedDpuSns, isExpectedOfflineSpare as isExpectedOfflineSpareShared } from './shp2Membership.js';
import {
  classifyDeviceLink,
  getDeviceReachability,
  deviceReachabilityEntities,
} from './deviceLink.js';

/**
 * System-wide alerts engine — the single source of truth. The web UI renders
 * snapshot.alerts (computed here); the alert monitor uses the same output to
 * decide what to push as a notification.
 */

export type Severity = 'critical' | 'warning' | 'info';

/** One labelled number in a learned alert's statistical breakdown. */
export interface AlertFact {
  label: string;
  value: string;
}

export interface Alert {
  id: string;
  severity: Severity;
  category: 'Battery' | 'Solar' | 'Thermal' | 'SHP2' | 'Grid' | 'Connectivity';
  device: string;
  title: string;
  detail: string;
  /** 'threshold' = static rule (default); 'learned' = anomaly/forecast engine. */
  source?: 'threshold' | 'learned';
  /**
   * v0.44.0 — explicit ISA priority/tier. When present, priorityOf() reads this
   * FIRST and skips the severity+source heuristic. Lets a REAL measured
   * threshold crossing reach ISA Medium without faking source='learned' (which
   * would route it onto the Predictive page and mislabel it in cleared history).
   * Omit it and the legacy severity+source derivation still applies.
   */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Subject identity — Core (DPU) number, then pack number, when scoped to one. */
  coreNum?: number | null;
  packNum?: number | null;
  /** Structured statistical breakdown — populated for learned alerts. */
  facts?: AlertFact[];
  /**
   * v0.16.4 — annunciation gate. `false` = this condition stays VISIBLE in
   * snapshot.alerts (the UI still renders it) but must never produce an audible
   * broadcast, a push notification, or raise the broadcast condition level.
   * `undefined`/`true` = annunciate normally. Used for expected-steady-state
   * conditions like a designated bench spare reporting offline. Mirrors the
   * "never hide an active alarm, only mute it" pattern (v0.11.0). The two
   * annunciation channels honour it: broadcast.conditionFromAlerts (audible) and
   * alertMonitor's rising-edge router (push, above the quiet-hours digest queue).
   */
  annunciate?: boolean;
}

const cToF = (c: number) => c * 1.8 + 32;

/*
 * MPPT idle/shed guard (v0.9.80, watt-based since v0.9.81). During
 * curtailment AND at sunset the DPU sheds/winds-down a string: the input
 * shows voltage but ~0 W, and EcoFlow reports a non-zero *standby* status
 * in hvPvErrCode / lvPvErrCode that is NOT a fault. Live proof: at sunset
 * ALL cores reported HV err=457 / LV err=177 simultaneously (a real fault
 * can't be identical across independent units), with strings at 0 W — one
 * HV string drew a 0.275 A shutdown trickle (above the old 0.1 A floor) and
 * slipped through. A string is only meaningfully "producing" — so a code is
 * a real error worth flagging — when it's making real WATTS. Below the floor
 * it's idle/shedding/shutting-down and any code is benign standby.
 */
const MPPT_WATT_FLOOR = 20;   // W — below this the string isn't meaningfully producing
const mpptProducing = (watts: number | null): boolean =>
  watts != null && watts > MPPT_WATT_FLOOR;

/*
 * Thresholds. EcoFlow's API does NOT expose cell-imbalance or temperature alarm
 * limits, so these are our own (general LFP best practice). Where EcoFlow exposes
 * an operating limit (emsParaVol window) we use its numbers directly.
 */
type TempBand = { infoF: number; warnF: number; critF?: number };
const CELL_TEMP: TempBand = { infoF: 104, warnF: 113, critF: 131 };
const MOS_TEMP: TempBand = { infoF: 104, warnF: 131, critF: 149 };
const BOARD_TEMP: TempBand = { infoF: 113, warnF: 140, critF: 158 };
const SHUNT_TEMP: TempBand = { infoF: 113, warnF: 140 };
const MPPT_TEMP: TempBand = { infoF: 131, warnF: 149, critF: 167 };
const CELL_TEMP_COLD_F = 41;

const VOL_DIFF_WARN_MV = 20;
const VOL_DIFF_CRIT_MV = 50;
// v0.58.0 — on the LFP top-of-charge plateau (high SoC) cell spread transiently
// balloons even with the BMS idle (balanceState=0), so the static 50 mV crit
// chimed an audible klaxon repeatedly at the top of charge (live: 14 red
// broadcasts in two top-of-charge bursts while the resting spread was a healthy
// 2-5 mV). Above the plateau SoC, relax the critical threshold and keep a benign
// excursion VISIBLE-but-silent (a debounced, auto-silenceable warning) — exactly
// as the balancing gate does. A genuinely large spread (>= the relaxed ceiling)
// still goes critical + audible. Env-tunable.
const VOL_DIFF_PLATEAU_SOC_PCT = Number(process.env.VOL_DIFF_PLATEAU_SOC_PCT ?? 85);
const VOL_DIFF_PLATEAU_CRIT_MV = Number(process.env.VOL_DIFF_PLATEAU_CRIT_MV ?? 90);
const SOH_WARN_PCT = 85;
const SOH_CRIT_PCT = 75;
const PACK_SOC_LOW_PCT = 10;
const PACK_IMBALANCE_WARN_PCT = 15;
const STALE_MS = 3 * 60 * 1000;
const CIRCUIT_BREAKER_WARN_FRAC = 0.9;

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function classifyTemp(tempC: number, band: TempBand): Severity | null {
  const f = cToF(tempC);
  if (band.critF != null && f >= band.critF) return 'critical';
  if (f >= band.warnF) return 'warning';
  if (f >= band.infoF) return 'info';
  return null;
}

function tempAlert(opts: {
  idBase: string;
  device: string;
  label: string;
  tempC: number | null | undefined;
  band: TempBand;
}): Alert | null {
  if (opts.tempC == null) return null;
  const sev = classifyTemp(opts.tempC, opts.band);
  if (!sev) return null;
  const f = Math.round(cToF(opts.tempC));
  const verb = sev === 'critical' ? 'overheating' : sev === 'warning' ? 'running hot' : 'getting warm';
  const limit = sev === 'critical' ? opts.band.critF : sev === 'warning' ? opts.band.warnF : opts.band.infoF;
  return {
    id: `${opts.idBase}-${sev}`,
    severity: sev,
    category: 'Thermal',
    device: opts.device,
    title: `${opts.label} ${verb}`,
    detail: `${opts.label} at ${f}°F (${sev} ≥ ${limit}°F).`,
  };
}

/** Extract the Core (DPU) number from a device name like "Core 3". */
function dpuNum(name: string): number | null {
  const m = name.match(/core\s*(\d+)/i) ?? name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Connectivity context for the alerts engine (v0.7.7) — lets the offline-
 * device alert tell you when we last actually heard from EcoFlow Cloud about
 * a device, and lets us surface a "cloud session stale" alert when the REST
 * `/device/list` poll itself has stopped succeeding (in that case the per-
 * device `online` flags can't be trusted).
 */
export interface ConnectivityContext {
  lastDeviceListAttemptAt: number;   // 0 = never attempted
  lastDeviceListSuccessAt: number;   // 0 = never succeeded
  perDevice: Map<string, { lastMqttAt?: number; lastSource?: 'rest' | 'mqtt'; mqttCount: number }>;
}

/** Format an age in ms as the most natural short human string. */
function fmtAge(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '∞';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// `/device/list` polls every 60 s by default; if we haven't had a successful
// poll in 5 min the session is genuinely stale and any "online: 0" we're
// showing is unreliable.
const CLOUD_SESSION_STALE_MS = 5 * 60 * 1000;

export function computeAlerts(
  devices: Record<string, DeviceSnapshot>,
  connectivity?: ConnectivityContext,
  /** v0.23.0 — when the grid is backstopping the home, a backup pool at/below
   *  the reserve floor merely transfers to mains, so the reserve alerts are
   *  downgraded from critical to an on-screen advisory. Omitted ⇒ treat as
   *  off-grid (reserve alerts stay critical — the safe default).
   *  v0.43.0 — also carries `present` (the GridBackstop resolver's grid-availability
   *  signal) so the off-grid alert can use the same source of truth as
   *  binary_sensor.off_grid / /api/ha-state instead of the obsolete acIn<5 heuristic. */
  grid?: { present?: boolean; backstopping: boolean; reason?: string },
): Alert[] {
  const out: Alert[] = [];
  const list = Object.values(devices);
  const now = Date.now();

  // v0.7.7 — cloud-session-stale check. If we haven't had a successful
  // /device/list response in CLOUD_SESSION_STALE_MS, the per-device online
  // flags we're displaying are last-known values, not current state. Tell
  // the user we don't actually know whether anything is offline right now
  // — that's the actual diagnosis, not "your panel is offline".
  if (connectivity) {
    const successAt = connectivity.lastDeviceListSuccessAt;
    const attemptAt = connectivity.lastDeviceListAttemptAt;
    if (attemptAt > 0 && (successAt === 0 || now - successAt > CLOUD_SESSION_STALE_MS)) {
      const sinceSuccess = successAt === 0 ? '∞' : fmtAge(now - successAt);
      out.push({
        id: 'cloud-session-stale',
        severity: 'warning',
        category: 'Connectivity',
        device: 'EcoFlow Cloud',
        title: 'EcoFlow Cloud session stale',
        detail: `Haven't received a fresh /device/list response in ${sinceSuccess}. Per-device online/offline indicators below reflect the last successful poll, NOT current state. Most likely an EcoFlow Cloud or network blip; usually self-recovers within a few minutes.`,
        facts: [
          { label: 'Last successful poll', value: sinceSuccess + ' ago' },
          { label: 'Last attempt', value: attemptAt > 0 ? fmtAge(now - attemptAt) + ' ago' : 'never' },
          { label: 'Threshold', value: fmtAge(CLOUD_SESSION_STALE_MS) },
        ],
      });
    }
  }

  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  // Grid-tied = AC input on an SHP2-bound DPU (the house's grid path). A spare
  // DPU plugged into a wall to self-charge must NOT register as grid power.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  // Only SHP2-bound cores count as grid import. When the source set is unknown
  // (no SHP2 observed yet) count NONE — a wall-charging spare must never suppress
  // the off-grid advisory, and acIn=0 keeps the safe "off-grid" default (v0.43.0,
  // Copilot review). Note this `acIn` path is the FALLBACK only — when the grid
  // resolver is supplied (always, in production) the off-grid decision uses
  // `grid.present` and never reaches here.
  const acIn = dpus
    .filter((d) => d.online && sourceSns.has(d.sn))
    .reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  // v0.43.0 — off-grid detection now uses the grid-presence RESOLVER (the same
  // `present` signal driving binary_sensor.off_grid and /api/ha-state since v0.40.0),
  // not the obsolete DPU acIn<5 sum. acIn reads 0 whenever PV/battery covers DPU
  // charging EVEN WHILE the grid carries home load directly through the SHP2 main, so
  // the old heuristic fired "Running off-grid" 24/7 on a grid-tied home (a live false
  // alert). When `present` is supplied we trust it; when grid is omitted entirely we
  // fall back to acIn<5 (and the safe default stays "off-grid" → alert visible).
  const offGrid = grid?.present === true ? false : grid?.present === false ? true : acIn < 5;
  if (offGrid) {
    out.push({ id: 'grid-offgrid', severity: 'info', category: 'Grid', device: 'System', title: 'Running off-grid', detail: 'No grid connection detected — home running on solar + batteries.' });
  }

  // v0.16.4 — designated bench spares (Core 4/5) are intentionally kept powered
  // down and are NOT wired into the SHP2, so their EcoFlow-offline / stale state
  // is an EXPECTED steady state, not an event. Such a DPU's connectivity alert
  // is emitted non-annunciating (visible in the UI, but no chime/push/condition
  // raise — see the offline/stale branches below). The SPARE_DPU_SNS allowlist
  // is the safety FLOOR: a real home core (1/2/3) is never in it, so even a
  // faulted/unplugged home core — which drops out of the SHP2's connected
  // sources — still annunciates its genuine offline alarm. The positive
  // connected-source check re-arms a spare the moment it's wired into an SHP2.
  // v0.52.0 — compute the connected-source Set ONCE, then delegate each
  // membership check to the shared shp2Membership.isExpectedOfflineSpare,
  // passing the Set so no per-call rescan of `devices` happens at the hot
  // sites below. Behavior is identical to the former local closure
  // (`SPARE_DPU_SNS.has(sn) && !shp2Connected.has(sn)`).
  const shp2Connected = shp2ConnectedDpuSns(devices);
  const isExpectedOfflineSpare = (sn: string): boolean =>
    isExpectedOfflineSpareShared(sn, shp2Connected);

  for (const d of list) {
    const isCore = d.productName.toLowerCase().includes('delta pro ultra');
    const spare = isCore && isExpectedOfflineSpare(d.sn);
    const coreNum = isCore ? dpuNum(d.deviceName) : null;
    if (!d.online) {
      const isPanel = d.productName.toLowerCase().includes('smart home panel');
      // v0.7.7 — enrich the offline alert with WHEN we last actually heard
      // from the device and via which channel. A 47-min gap with last data
      // via MQTT looks very different from "never connected since boot".
      const conn = connectivity?.perDevice.get(d.sn);
      const lastDataAt = conn?.lastMqttAt ?? d.lastUpdated ?? 0;
      const lastSource = conn?.lastSource ?? 'rest';
      const facts: Array<{ label: string; value: string }> = [
        { label: 'Reported by', value: 'EcoFlow Cloud /device/list' },
        { label: 'Last data', value: lastDataAt > 0 ? `${fmtAge(now - lastDataAt)} ago (${lastSource.toUpperCase()})` : 'no data this session' },
        { label: 'MQTT msg count', value: conn?.mqttCount != null ? String(conn.mqttCount) : '—' },
      ];
      // Append a one-line action hint matched to the most likely cause.
      const ageMin = lastDataAt > 0 ? (now - lastDataAt) / 60_000 : Infinity;
      let hint =
        ageMin > 30
          ? ' No telemetry for over 30 minutes — the device has lost its EcoFlow cloud (enhanced) connection. It usually recovers once the cloud session re-establishes; if it stays offline, a power-cycle forces a clean reconnect.'
          : ageMin > 5
            ? ' Data is stale but recent — the cloud session may catch up on its own. Wait a few minutes; if it persists, power-cycle.'
            : ' Just dropped — likely a brief blip. Will re-evaluate.';
      // Cloud-wedge vs real-outage classification. EcoFlow's cloud says OFFLINE
      // but gives no IP, so LAN reachability comes from an operator-configured HA
      // ping binary_sensor (ECOFLOW_DEVICE_REACHABILITY → setDeviceReachability,
      // populated by the main loop). PURELY additive: this only adds a fact and
      // refines the hint text — it never changes the alert's id, severity,
      // whether it fires, or the spare-gating. Dormant when unconfigured: the
      // fact is omitted entirely (no 'unknown' noise) and the hint is unchanged.
      const reachabilityConfigured = d.sn in deviceReachabilityEntities();
      if (reachabilityConfigured) {
        const link = classifyDeviceLink(false, getDeviceReachability(d.sn));
        if (link === 'cloud_wedge') {
          facts.push({ label: 'LAN reachability', value: 'Reachable (cloud session wedged)' });
          hint =
            ' The device IS reachable on the LAN, so this is an EcoFlow cloud-session wedge — its cloud/MQTT pipe stalled while the device itself is alive and on the network. Telemetry will resume when the cloud session re-establishes; do NOT power-cycle reflexively (it just interrupts a healthy unit and masks the cloud-side stall).';
        } else if (link === 'real_outage') {
          facts.push({ label: 'LAN reachability', value: 'Unreachable (no LAN ping)' });
          hint =
            ' The device is NOT reachable on the LAN, so this is likely a genuine power or network outage rather than a cloud wedge — check the device power, its breaker, and WiFi/router.';
        } else {
          // 'unknown' — entity configured but state unavailable. Surface the
          // ambiguity as a fact but leave the existing age-based hint unchanged.
          facts.push({ label: 'LAN reachability', value: 'Unknown (ping sensor unavailable)' });
        }
      }
      out.push({
        id: `offline-${d.sn}`,
        // A designated bench spare offline is expected, not a warning, and is
        // marked non-annunciating so it never chimes/pushes/raises the condition.
        severity: spare ? 'info' : isCore || isPanel ? 'warning' : 'info',
        // v0.76.0 — explicit ISA priority so a connectivity wedge no longer maps to
        // High/P2 ("a protective hardware limit has been crossed"), which inflated a
        // known, non-actionable cloud-offline to the same tier as a real hardware
        // breach and masked genuine P2s. The SHP2/Panel offline stays High (it is the
        // alarm DATA SOURCE — losing it degrades the floor/SoC alarm inputs); a home
        // Core offline is Medium/P3 (the SHP2 aggregate still covers the backup pool —
        // it needs attention, e.g. a network power-cycle, but isn't an emergency); a
        // peripheral offline is Low/P4. Spares stay non-annunciating regardless.
        priority: spare ? 'low' : isPanel ? 'high' : isCore ? 'medium' : 'low',
        category: 'Connectivity',
        device: d.deviceName,
        title: spare ? 'Bench spare offline (expected)' : 'Device offline (per EcoFlow Cloud)',
        detail: spare
          ? `${d.deviceName} is a designated bench spare — kept powered down and not wired into the SHP2 — so EcoFlow Cloud reporting it offline is expected and not actionable. It will alarm normally once it's connected to an SHP2.`
          : `${d.deviceName} is flagged offline by EcoFlow's /device/list. ${conn?.mqttCount && conn.mqttCount > 0 ? `We previously received ${conn.mqttCount} MQTT message(s) this session; last data ${fmtAge(now - lastDataAt)} ago via ${lastSource.toUpperCase()}.` : 'No telemetry received this session.'}${hint}`,
        coreNum,
        facts,
        ...(spare ? { annunciate: false } : {}),
      });
    } else if (d.projection && d.lastUpdated && now - d.lastUpdated > STALE_MS) {
      const conn = connectivity?.perDevice.get(d.sn);
      out.push({
        id: `stale-${d.sn}`,
        severity: spare ? 'info' : 'warning',
        category: 'Connectivity',
        device: d.deviceName,
        title: spare ? 'Bench spare telemetry idle (expected)' : 'Telemetry stale',
        detail: spare
          ? `${d.deviceName} is a designated bench spare not wired into the SHP2; intermittent or absent telemetry is expected. It will alarm normally once it's connected to an SHP2.`
          : `${d.deviceName} is flagged online by EcoFlow but no fresh telemetry for ${fmtAge(now - d.lastUpdated)}. ${conn?.lastMqttAt ? `Last MQTT msg ${fmtAge(now - conn.lastMqttAt)} ago.` : ''}`,
        coreNum,
        facts: [
          { label: 'Last telemetry', value: `${fmtAge(now - d.lastUpdated)} ago` },
          { label: 'Last source', value: conn?.lastSource?.toUpperCase() ?? 'unknown' },
          { label: 'MQTT msg count', value: conn?.mqttCount != null ? String(conn.mqttCount) : '—' },
        ],
        ...(spare ? { annunciate: false } : {}),
      });
    }
  }

  for (const d of dpus) {
    if (!d.online || !d.projection) continue;
    const p = d.projection;
    const coreNum = dpuNum(d.deviceName);
    const dpuStart = out.length;

    if ((p.sysErrCode ?? 0) !== 0) {
      out.push({ id: `dpu-err-${d.sn}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Inverter error code', detail: `${d.deviceName} reports system error code ${p.sysErrCode}.` });
    }
    // v0.9.80 — only flag an MPPT error code when that string is actually
    // PRODUCING. During curtailment the DPU sheds the LV string (and
    // throttles HV): the input shows open-circuit voltage but ~0 A / 0 W,
    // and EcoFlow reports a non-zero *standby* status in hvPvErrCode /
    // lvPvErrCode that is NOT a fault. The 42h log queued "HV/LV MPPT error
    // code" 17× while live codes read 0 — the classic shed signature.
    // Mirror the UI's channelState thresholds (web SolarPanel.tsx): a code
    // is only a real error if the string is drawing current.
    if ((p.pvHighErrCode ?? 0) !== 0 && mpptProducing(p.pvHighWatts)) {
      out.push({ id: `dpu-pvh-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'HV MPPT error code', detail: `${d.deviceName} HV solar input reports error code ${p.pvHighErrCode} while producing ${p.pvHighWatts?.toFixed(0)} W (${p.pvHighVolts?.toFixed(0)} V, ${p.pvHighAmps?.toFixed(1)} A).` });
    }
    if ((p.pvLowErrCode ?? 0) !== 0 && mpptProducing(p.pvLowWatts)) {
      out.push({ id: `dpu-pvl-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'LV MPPT error code', detail: `${d.deviceName} LV solar input reports error code ${p.pvLowErrCode} while producing ${p.pvLowWatts?.toFixed(0)} W (${p.pvLowVolts?.toFixed(0)} V, ${p.pvLowAmps?.toFixed(1)} A).` });
    }

    for (const [label, slug, c] of [
      ['HV MPPT', 'hv', p.mpptHvTemp],
      ['LV MPPT', 'lv', p.mpptLvTemp],
    ] as const) {
      // v0.26.0 — channel slug ('hv'/'lv') BEFORE the SN and lowercase, so
      // familyOf() (which stops at the first uppercase token = the SN) yields
      // per-channel families `mppt-hv-temp` / `mppt-lv-temp` instead of collapsing
      // every device+string+severity into one bare `mppt` rollup — which had
      // pooled a spare's info-MPPT noise against a home core's warning/critical
      // for the auto-silence decision. Human label unchanged ('HV/LV MPPT').
      const a = tempAlert({ idBase: `mppt-${slug}-temp-${d.sn}`, device: d.deviceName, label: `${d.deviceName} ${label}`, tempC: c, band: MPPT_TEMP });
      if (a) out.push(a);
    }

    if (p.batVol != null && p.emsParaVolMinMv != null && p.emsParaVolMaxMv != null) {
      const batMv = p.batVol * 1000;
      if (batMv < p.emsParaVolMinMv || batMv > p.emsParaVolMaxMv) {
        out.push({ id: `ems-volt-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack voltage outside EMS window', detail: `${d.deviceName} at ${p.batVol.toFixed(1)} V — outside EcoFlow's ${(p.emsParaVolMinMv / 1000).toFixed(1)}–${(p.emsParaVolMaxMv / 1000).toFixed(1)} V parallel-operation window.` });
      }
    }

    const packSocs = p.packs.map((pk) => pk.soc).filter((s): s is number => s != null);
    if (packSocs.length > 1) {
      const spread = Math.max(...packSocs) - Math.min(...packSocs);
      if (spread >= PACK_IMBALANCE_WARN_PCT) {
        out.push({ id: `dpu-imbalance-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Packs out of balance', detail: `${spread.toFixed(0)}% SoC spread across ${d.deviceName}'s packs (≥ ${PACK_IMBALANCE_WARN_PCT}%).` });
      }
    }

    for (const pk of p.packs) {
      const tag = `${d.deviceName} Pack ${pk.num}`;
      const packStart = out.length;
      const soh = pk.actSoh ?? pk.soh;
      if (soh != null && soh < SOH_CRIT_PCT) {
        out.push({ id: `soh-crit-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Pack health critical', detail: `${tag} SoH ${soh.toFixed(1)}% (critical < ${SOH_CRIT_PCT}%).` });
      } else if (soh != null && soh < SOH_WARN_PCT) {
        out.push({ id: `soh-warn-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack health degraded', detail: `${tag} SoH ${soh.toFixed(1)}% (warning < ${SOH_WARN_PCT}%).` });
      }

      const balancing = pk.balanceState != null && pk.balanceState !== 0;
      if (pk.maxVolDiffMv != null) {
        const balanceNote = balancing ? ' BMS is actively balancing the cells.' : '';
        // v0.29.0 — the static vdiff-crit threshold is INSTANTANEOUS with no
        // hysteresis, and critical alerts get 0 ms debounce + are exempt from all
        // auto-silencing — so a 50 mV transient pushed a CRITICAL chime on every
        // rise (live: 67 rises, 69% cleared < 10 min, 3-min median, coinciding
        // with benign BMS cell-balancing). A brief spread excursion WHILE the BMS
        // is actively balancing is expected housekeeping, not a fault: keep the
        // alert VISIBLE (dashboard still shows it, with the balancing note) but mark
        // it annunciate:false so it never chimes/pushes during balancing. A genuine
        // sustained imbalance persists past balancing and re-fires annunciating.
        // v0.58.0 — relaxed critical ceiling on the high-SoC LFP plateau (see
        // VOL_DIFF_PLATEAU_* constants). packSoc prefers the pack reading and falls
        // back to the device-projection SoC (pack soc is often null in DPU telemetry).
        const packSoc = pk.soc ?? p.soc;
        const onPlateau = packSoc != null && packSoc >= VOL_DIFF_PLATEAU_SOC_PCT;
        const critMv = onPlateau ? VOL_DIFF_PLATEAU_CRIT_MV : VOL_DIFF_CRIT_MV;
        // A benign top-of-charge plateau excursion — a spread that WOULD have been
        // critical off-plateau (>= VOL_DIFF_CRIT_MV) but sits under the relaxed
        // plateau ceiling, with the BMS idle — stays VISIBLE but never chimes/pushes
        // (same treatment as the balancing case). Normal warn-range spread
        // (20..49 mV) keeps its usual annunciation; only the demoted-from-critical
        // band is silenced, so the operator isn't klaxoned by expected LFP plateau
        // spread. The silence is BOUNDED: as soon as SoC drops below the plateau
        // (any discharge below VOL_DIFF_PLATEAU_SOC_PCT), the standard 50 mV critical
        // re-arms — so a genuinely diverging pack still alarms audibly each cycle,
        // and it stays visible as a warning meanwhile (SoH/degradation engines also
        // track it independently).
        const plateauBenign = onPlateau && !balancing && pk.maxVolDiffMv >= VOL_DIFF_CRIT_MV && pk.maxVolDiffMv < critMv;
        const plateauNote = plateauBenign ? ' Expected top-of-charge cell spread.' : '';
        const annun = (balancing || plateauBenign) ? { annunciate: false } : {};
        if (pk.maxVolDiffMv >= critMv) {
          out.push({ id: `vdiff-crit-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Cell imbalance', detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (critical ≥ ${critMv} mV).${balanceNote}`, ...annun });
        } else if (pk.maxVolDiffMv >= VOL_DIFF_WARN_MV) {
          out.push({ id: `vdiff-warn-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Cell imbalance', detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (warning ≥ ${VOL_DIFF_WARN_MV} mV).${balanceNote}${plateauNote}`, ...annun });
        }
      }
      if (balancing) {
        out.push({ id: `balancing-${d.sn}-${pk.num}`, severity: 'info', category: 'Battery', device: d.deviceName, title: 'Pack balancing cells', detail: `${tag} BMS is actively balancing — normal housekeeping, no action needed.` });
      }

      const cellA = tempAlert({ idBase: `temp-cell-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} cells`, tempC: pk.maxCellTemp ?? pk.temp, band: CELL_TEMP });
      if (cellA) out.push(cellA);
      const mosA = tempAlert({ idBase: `temp-mos-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} MOSFETs`, tempC: pk.maxMosTemp, band: MOS_TEMP });
      if (mosA) out.push(mosA);
      const boardA = tempAlert({ idBase: `temp-board-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} BMS board`, tempC: pk.hwBoardTemp, band: BOARD_TEMP });
      if (boardA) out.push(boardA);
      const shuntA = tempAlert({ idBase: `temp-shunt-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} current shunt`, tempC: pk.curResTemp, band: SHUNT_TEMP });
      if (shuntA) out.push(shuntA);

      const coldC = pk.minCellTemp ?? pk.temp;
      if (coldC != null && cToF(coldC) <= CELL_TEMP_COLD_F) {
        out.push({ id: `temp-cold-${d.sn}-${pk.num}`, severity: 'warning', category: 'Thermal', device: d.deviceName, title: `${tag} cold`, detail: `${tag} at ${Math.round(cToF(coldC))}°F — charging derates near freezing.` });
      }

      if (pk.soc != null && pk.soc <= PACK_SOC_LOW_PCT) {
        out.push({ id: `soc-low-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack nearly empty', detail: `${tag} at ${pk.soc}% state of charge.` });
      }
      for (let i = packStart; i < out.length; i++) out[i].packNum = pk.num;
    }
    for (let i = dpuStart; i < out.length; i++) out[i].coreNum = coreNum;
    // v0.26.0 — a bench spare (in SPARE_DPU_SNS, not wired into the SHP2) stays
    // online for diagnostics but must NEVER chime/push. The v0.16.4 gate only
    // covered the offline/stale branches; stamp annunciate:false on everything
    // this online spare just emitted (dpu-err, mppt-*, vdiff-*, soh-*, soc-low,
    // temp-*, ems-volt, imbalance). Stays visible on-screen; auto-re-arms once
    // it's wired into an SHP2 (shp2ConnectedDpuSns then includes it).
    if (isExpectedOfflineSpare(d.sn)) {
      for (let i = dpuStart; i < out.length; i++) {
        if (out[i].annunciate !== false) out[i].annunciate = false;
      }
    }
  }

  if (shp2?.online && shp2.projection) {
    const sp = shp2.projection;
    const reserve = sp.backupReserveSoc ?? 15;
    if (sp.backupBatPercent != null) {
      if (sp.backupBatPercent < reserve) {
        // v0.23.0 — when the grid is backstopping the home, the pool sitting at
        // its reserve floor just transfers to mains; downgrade critical → info
        // (still visible) so it doesn't push/chime as an emergency.
        const onGrid = grid?.backstopping === true;
        out.push({
          id: 'shp2-below-reserve',
          severity: onGrid ? 'info' : 'critical',
          category: 'SHP2',
          device: shp2.deviceName,
          title: onGrid ? 'Backup at reserve — on grid' : 'Backup below reserve',
          detail: onGrid
            ? `Backup pool ${sp.backupBatPercent}% is at/under the ${reserve}% reserve floor — drawing from grid power, no action needed (${grid?.reason ?? 'grid backstopping'}).`
            : `Backup pool ${sp.backupBatPercent}% is under the ${reserve}% reserve floor.`,
        });
      } else if (sp.backupBatPercent < reserve + 10) {
        // v0.43.0 — grid-aware, mirroring shp2-below-reserve above: while the grid
        // backstops the home, approaching the reserve floor merely transfers to mains,
        // so downgrade warning → info (still visible, no chime/push). A real outage
        // (grid absent ⇒ backstopping false) keeps it 'warning'.
        const onGrid = grid?.backstopping === true;
        out.push({
          id: 'shp2-near-reserve',
          severity: onGrid ? 'info' : 'warning',
          category: 'SHP2',
          device: shp2.deviceName,
          title: 'Backup approaching reserve',
          detail: onGrid
            ? `Backup pool ${sp.backupBatPercent}% is close to the ${reserve}% reserve floor — grid is backstopping, no action needed (${grid?.reason ?? 'grid backstopping'}).`
            : `Backup pool ${sp.backupBatPercent}% is close to the ${reserve}% reserve floor.`,
        });
      }
    }
    for (const s of sp.sources) {
      const tag = `SHP2 slot ${s.slot}`;
      if ((s.errorCodeNum ?? 0) !== 0) {
        out.push({ id: `shp2-src-err-${s.slot}`, severity: 'critical', category: 'SHP2', device: shp2.deviceName, title: 'Energy source error', detail: `${tag} reports ${s.errorCodeNum} error(s).` });
      }
      if (s.isConnected && !s.hwConnect) {
        out.push({ id: `shp2-src-hw-${s.slot}`, severity: 'warning', category: 'SHP2', device: shp2.deviceName, title: 'Source link issue', detail: `${tag} shows connected but no hardware link.` });
      }
    }
    for (const pc of sp.pairedCircuits) {
      if (pc.watts == null || pc.breakerAmps == null) continue;
      const v = pc.isSplitPhase ? 240 : 120;
      const capacity = pc.breakerAmps * v;
      if (pc.watts >= capacity * CIRCUIT_BREAKER_WARN_FRAC) {
        out.push({ id: `circuit-overload-${pc.primaryCh}`, severity: 'warning', category: 'SHP2', device: shp2.deviceName, title: 'Circuit near breaker limit', detail: `${pc.name} drawing ${Math.round(pc.watts)} W — over ${Math.round(CIRCUIT_BREAKER_WARN_FRAC * 100)}% of its ${pc.breakerAmps} A breaker.` });
      }
    }
  }

  // v0.12.0 — backup-pool SoC band alert. One on-screen alert for the lowest
  // SoC threshold the backup pool is currently at/below (40/30/20/15/10/8/4/2 %),
  // its severity/source chosen by socAlertSeverity so priorityOf() derives the
  // matching ISA tier (Low→Critical). The audible escalating alarm is fired
  // separately via broadcast.announce (batterySocAlarm + index.ts); the id MUST
  // start with 'backup-soc' so broadcast.ts excludes it from its own chime and
  // the dedicated announce stays the sole SoC audible.
  const socShp2 = list.find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const soc = socShp2?.projection.backupBatPercent ?? null;
  const band = activeSocBand(soc);
  // v0.44.0 — dedup: the shp2-near-reserve / shp2-below-reserve pair above
  // (grid-aware) already owns the soc < reserve+10 window. Suppress the
  // backup-soc band push inside that window so the reserve story has ONE
  // on-screen producer; only emit the band alert ABOVE it. The shp2 pair fully
  // covers the suppressed window (near = reserve..reserve+10, below = <reserve),
  // so no reserve condition is dropped. Use the SAME reserve default as that
  // block (sp.backupReserveSoc ?? 15). The audible SoC alarm ladder is
  // untouched — this only gates the on-screen mirror.
  const socReserve = socShp2?.projection.backupReserveSoc ?? 15;
  // v0.44.0 — only treat the window as "covered" when the shp2-near/below pair is
  // actually ELIGIBLE to emit, i.e. the SHP2 is ONLINE (that pair is gated on
  // `shp2?.online` at line ~430). When the SHP2 is cloud-offline its projection —
  // hence `soc` — is still preserved by the snapshot store, but the pair does NOT
  // fire; suppressing the band too would drop the low-SoC reserve alert entirely.
  // Gating here keeps the band as the fallback on a faulted/offline SHP2.
  const coveredByShp2Pair = socShp2?.online === true && soc != null && soc < socReserve + 10;
  if (band !== null && soc != null && !coveredByShp2Pair) {
    // v0.23.0 — grid backstopping ⇒ a low pool is a non-event; collapse the
    // emergency tiers (high/critical) to a low advisory so this on-screen alert
    // tracks the (also-downgraded) audible SoC alarm in lockstep.
    const onGridEmergency =
      grid?.backstopping === true && (band.priority === 'critical' || band.priority === 'high');
    // v0.44.0 — source is always 'threshold' now; the explicit ISA `priority`
    // (spread below) is what reaches Medium, so reserve bands show on the
    // operational Alerts page and read correctly in cleared history.
    const { severity, source, priority } = socAlertSeverity(onGridEmergency ? 'low' : band.priority);
    out.push({
      id: `backup-soc-${band.pct}`,
      severity,
      source,
      priority,
      category: 'Battery',
      device: 'SHP2 backup pool',
      title: `Backup pool low — ${Math.round(soc)}%`,
      detail: onGridEmergency
        ? `Backup reserve at ${Math.round(soc)}%, at/below the ${band.pct}% threshold — drawing from grid power, no action needed.`
        : `Backup reserve at ${Math.round(soc)}%, at or below the ${band.pct}% ${band.priority}-priority threshold.`,
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.category.localeCompare(b.category));
}

export function alertCounts(alerts: Alert[]): Record<Severity, number> {
  return {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
  };
}
