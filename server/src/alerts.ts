import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import { activeSocBand, socAlertSeverity } from './batterySocAlarm.js';
import { shp2ConnectedDpuSns, isExpectedOfflineSpare as isExpectedOfflineSpareShared, homeFleetMeanSoc } from './shp2Membership.js';
import { liveHostPower } from './hostPower.js';
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
/** A — just above the 0.275 A sunset shutdown trickle observed on Core 2 (v0.9.81 note). */
const MPPT_AMP_FLOOR = 0.3;

/**
 * v1.0.1 — a string counts as PRODUCING only when it makes real watts AND actually
 * draws current. The two documented false-positive modes are complementary, and each
 * single-signal guard let the other through:
 *
 *   v0.9.80 amp floor  → a 0 W / 0.275 A sunset shutdown trickle slipped past it.
 *   v0.9.81 watt floor → a dusk HV reading of 55 W while amps read 0.0 A slips past it.
 *                        (Observed live: Core 3, code 457, 294 V, 0.0 A, 55 W — the alert
 *                        text literally read "producing 55 W (294 V, 0.0 A)". EcoFlow's
 *                        watt and amp fields disagree during the ramp-down, so neither
 *                        alone is trustworthy.) All three home Cores reported the SAME
 *                        code 457 at that instant — and a real fault cannot be identical
 *                        across independent units, confirming benign standby.
 *
 * Requiring BOTH signals rejects both modes. `amps == null` (device doesn't report
 * current) falls back to the watt test alone rather than silently suppressing.
 */
const mpptProducing = (watts: number | null, amps: number | null): boolean => {
  if (watts == null || watts <= MPPT_WATT_FLOOR) return false;
  if (amps == null) return true;
  return amps > MPPT_AMP_FLOOR;
};

/*
 * Thresholds. EcoFlow's API does NOT expose cell-imbalance or temperature alarm
 * limits, so these are our own (general LFP best practice). Where EcoFlow exposes
 * an operating limit (emsParaVol window) we use its numbers directly.
 *
 * v-r14 — exported so the telnet TUI (screens.ts, plant/gen.ts) can colour live
 * temperature readouts against the SAME bands this engine alarms on, instead of
 * maintaining separate, drifted copies. One band per physically-distinct sensor:
 * a hot MPPT or MOSFET is normal where a hot LFP cell is not.
 */
export type TempBand = { infoF: number; warnF: number; critF?: number };
export const CELL_TEMP: TempBand = { infoF: 104, warnF: 113, critF: 131 };
export const MOS_TEMP: TempBand = { infoF: 104, warnF: 131, critF: 149 };
export const BOARD_TEMP: TempBand = { infoF: 113, warnF: 140, critF: 158 };
export const SHUNT_TEMP: TempBand = { infoF: 113, warnF: 140 };
export const MPPT_TEMP: TempBand = { infoF: 131, warnF: 149, critF: 167 };
// PTC elements are resistive HEATERS, not sensors to protect — they run hot by
// design (self-regulating Curie-point heaters typically operate ~60-90 °C /
// 140-194 °F). No PTC alert is wired into computeAlerts() below; this band
// exists solely so the TUI doesn't paint a normally-hot heater the same
// red/yellow as an overheating battery cell.
export const PTC_TEMP: TempBand = { infoF: 158, warnF: 176, critF: 194 };
export const CELL_TEMP_COLD_F = 41;

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
  /** v1.8.0 (review F3) — ms epoch when the SHP2's published backup-pool % went
   *  null (post-grace-hold; SnapshotStore.backupPoolUnknownSince), or null while
   *  readable. Drives the reserve-alarm-blind compensating alert. */
  backupPoolUnknownSinceMs?: number | null;
  /** v1.11.0 (review F8) — per-DPU inverter-error onset (SnapshotStore.dpuErrOnset),
   *  keyed by SN. The `dpu-err` CRITICAL is held until the SAME nonzero code has
   *  stood for DPU_ERR_DEBOUNCE_MS, so a cloud-reconnect blip (nonzero for
   *  20-160s, then clears) never reaches HA's critical_alerts sensor. */
  dpuErrOnsetBySn?: Map<string, { code: number; sinceMs: number }>;
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
// v1.8.0 (review F3) — reserve-alarm-blind debounce + escalation windows. 15 min
// of sustained pool-unreadability (well past the 3-min grace hold) before the
// warning fires; 60 min blind while NOT grid-backstopped escalates to critical
// (the escalation re-triggers the push channel via the alert monitor).
const RESERVE_BLIND_AFTER_MS = 15 * 60 * 1000;
const RESERVE_BLIND_CRITICAL_MS = 60 * 60 * 1000;
// v1.11.0 (review F8) — an inverter error must stand this long before the CRITICAL
// fires. The observed reconnect blips cleared within 20-160s; 3 min clears them all
// with margin while a genuine fault (which persists indefinitely) is delayed only
// one alarm-eval cycle past the window.
const DPU_ERR_DEBOUNCE_MS = 3 * 60 * 1000;

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

  // v1.6.0 — host power self-monitor. The Pi running this alarm is the whole
  // monitor's single point of failure: if it browns out, every channel goes
  // dark at once. HOST_POWER_ENTITY (HA's RPi Power Supply Checker, a
  // device_class=problem binary_sensor) trips on kernel under-voltage BEFORE
  // the Pi dies, so surface it as an early warning to fix the supply/circuit
  // while the alarm is still up. Dormant unless the entity is configured.
  const hostPower = liveHostPower();
  if (hostPower.underVoltage === true) {
    out.push({
      id: 'host-power-undervoltage',
      severity: 'warning',
      category: 'Connectivity',
      device: 'System',
      title: 'Alarm host power — under-voltage',
      detail: `The Raspberry Pi running this monitor reported under-voltage (${hostPower.entityId}). A marginal or failing power supply — or a sagging power circuit — can brown the host out and take the whole alarm dark. Check the Pi's supply and the circuit it's on before that happens.`,
    });
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
        // v1.8.0 (review F2) — spares get their OWN alert family. familyOf()
        // collapses `offline-<SN>` to one 'offline' family for every device, so
        // daily bench-spare churn (the spares' circuit power-cycles) tripped the
        // auto-silencer's high-volume rule on 06-04 and the latch then silently
        // dropped 134 real home-Core/SHP2 offline warnings. `offline-spare-<SN>`
        // rolls up under 'offline-spare' instead, so spare churn can never poison
        // the home-device family's dispatch stats.
        id: spare ? `offline-spare-${d.sn}` : `offline-${d.sn}`,
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
        // v1.8.0 (review F2) — same spare-family split as `offline-` above: a
        // bench spare's expected idle telemetry must not pollute the home
        // devices' 'stale' family stats.
        id: spare ? `stale-spare-${d.sn}` : `stale-${d.sn}`,
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
      // v1.11.0 (review F8) — debounce the CRITICAL: an SHP2/DPU cloud reconnect
      // blips sysErrCode nonzero for 20-160s then clears (07-02 fired two false
      // CRITICAL "Inverter error code" alerts → HA critical_alerts stepped to 2 →
      // any operator automation keyed on criticals>0 would have fired). A REAL
      // inverter fault persists. Suppress until the SAME code has stood for
      // DPU_ERR_DEBOUNCE_MS. Onset is tracked in the store (re-baselined on a
      // code change / clear). When the context is absent (older callers/tests),
      // the guard is skipped and the alert fires immediately — the pre-v1.11.0
      // behaviour, so no path silently loses a real fault.
      const onset = connectivity?.dpuErrOnsetBySn?.get(d.sn);
      const debounced = onset != null && onset.code === (p.sysErrCode ?? 0) && (now - onset.sinceMs) < DPU_ERR_DEBOUNCE_MS;
      if (!debounced) {
        out.push({ id: `dpu-err-${d.sn}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Inverter error code', detail: `${d.deviceName} reports system error code ${p.sysErrCode}.` });
      }
    }
    // v0.9.80 — only flag an MPPT error code when that string is actually
    // PRODUCING. During curtailment the DPU sheds the LV string (and
    // throttles HV): the input shows open-circuit voltage but ~0 A / 0 W,
    // and EcoFlow reports a non-zero *standby* status in hvPvErrCode /
    // lvPvErrCode that is NOT a fault. The 42h log queued "HV/LV MPPT error
    // code" 17× while live codes read 0 — the classic shed signature.
    // Mirror the UI's channelState thresholds (web SolarPanel.tsx): a code
    // is only a real error if the string is drawing current.
    // v1.0.1 — `mpptProducing` now needs BOTH watts and current (see its docstring): a
    // dusk ramp-down reports real-looking watts with ~0 A, which is standby, not a fault.
    if ((p.pvHighErrCode ?? 0) !== 0 && mpptProducing(p.pvHighWatts, p.pvHighAmps)) {
      out.push({ id: `dpu-pvh-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'HV MPPT error code', detail: `${d.deviceName} HV solar input reports error code ${p.pvHighErrCode} while producing ${p.pvHighWatts?.toFixed(0)} W (${p.pvHighVolts?.toFixed(0)} V, ${p.pvHighAmps?.toFixed(2)} A).` });
    }
    if ((p.pvLowErrCode ?? 0) !== 0 && mpptProducing(p.pvLowWatts, p.pvLowAmps)) {
      out.push({ id: `dpu-pvl-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'LV MPPT error code', detail: `${d.deviceName} LV solar input reports error code ${p.pvLowErrCode} while producing ${p.pvLowWatts?.toFixed(0)} W (${p.pvLowVolts?.toFixed(0)} V, ${p.pvLowAmps?.toFixed(2)} A).` });
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
        // v1.2.0 — this detail is read aloud by TTS on a CRITICAL alert, and "error(s)"
        // is not something a voice can say. errorCodeNum is a COUNT of active codes.
        const n = s.errorCodeNum!;
        out.push({ id: `shp2-src-err-${s.slot}`, severity: 'critical', category: 'SHP2', device: shp2.deviceName, title: 'Energy source error', detail: `${tag} reports ${n} ${n === 1 ? 'error' : 'errors'}.` });
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

  // v1.8.0 (review F3) — reserve-alarm-blind compensating alert. The entire
  // reserve chain (SoC ladder, near/below-reserve pair, runway) keys off the
  // SHP2's backup-pool %; the 30-day engine review found two cloud wedges (42.2h,
  // 25.8h) in which that value read null while the pool physically crossed
  // 50/40/30/20% — every reserve classifier sat dark for 17.8-20.8h with only a
  // generic connectivity warning. This alert says the RESERVE-specific thing:
  // "your reserve alarm is blind right now". Debounced to a sustained blind
  // window (the grace hold already absorbs reconnect blips; we additionally wait
  // RESERVE_BLIND_AFTER_MS) so routine flaps never fire it. Escalates to critical
  // after RESERVE_BLIND_CRITICAL_MS when the grid is NOT backstopping (off-grid,
  // a blind reserve alarm is genuinely dangerous) — the severity escalation
  // re-triggers the push channel via the alert monitor's escalation path. Listed
  // in ENERGY_STATE_FAMILIES so the auto-silencer can never eat it.
  if (shp2) {
    const sp2 = shp2.projection?.kind === 'shp2' ? (shp2.projection as Shp2Projection) : null;
    const poolNull = sp2 == null || sp2.backupBatPercent == null;
    let blindSinceMs: number | null = null;
    if (poolNull) {
      // Pool published as unknown — onset tracked by the snapshot store
      // (post-grace-hold). Fallback to lastUpdated when the context is absent.
      blindSinceMs = connectivity?.backupPoolUnknownSinceMs ?? shp2.lastUpdated ?? null;
    } else if (!shp2.online) {
      // Cloud says the SHP2 is offline: the projection (incl. the pool %) is a
      // FROZEN last-known value, not live truth. Blind since the last fresh data.
      blindSinceMs = shp2.lastUpdated ?? null;
    }
    const blindMs = blindSinceMs != null ? now - blindSinceMs : 0;
    if (blindSinceMs != null && blindMs >= RESERVE_BLIND_AFTER_MS) {
      const offGrid = grid?.backstopping !== true;
      const critical = offGrid && blindMs >= RESERVE_BLIND_CRITICAL_MS;
      const fallbackSoc = homeFleetMeanSoc(devices);
      const fallbackTxt = fallbackSoc != null
        ? `The SoC alarm ladder is running on the Core-fleet fallback (mean ${fallbackSoc.toFixed(0)}% across reporting Cores).`
        : 'No home Core is reporting either — the SoC alarm ladder is fully dark.';
      out.push({
        id: 'reserve-alarm-blind',
        severity: critical ? 'critical' : 'warning',
        category: 'Connectivity',
        device: shp2.deviceName,
        title: critical ? 'Reserve alarm blind — off-grid' : 'Reserve alarm blind',
        detail: `SHP2 backup-pool telemetry has been unreadable for ${fmtAge(blindMs)} — the reserve/runway alarms cannot see the pool. ${fallbackTxt}${offGrid ? '' : ' Grid is backstopping the home, so a low pool would transfer to mains.'} If this persists, power-cycle the SHP2 network connection.`,
        facts: [
          { label: 'Blind for', value: fmtAge(blindMs) },
          { label: 'Fallback ladder', value: fallbackSoc != null ? `${fallbackSoc.toFixed(0)}% (Core-fleet mean)` : 'unavailable' },
          { label: 'Escalates', value: offGrid ? `critical after ${fmtAge(RESERVE_BLIND_CRITICAL_MS)} blind` : 'suppressed while grid backstops' },
        ],
      });
    }
  }

  // v0.12.0 — backup-pool SoC band alert. One on-screen alert for the lowest
  // SoC threshold the backup pool is currently at/below (50/40/30/20/15/10/8/4/2 %),
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

/* ── v0.83.0 — SYSTEM DATA-GAP / UNPLANNED-OUTAGE ALERTING ──────────────────
 * The recorder already DETECTS + persists telemetry blackouts (a stretch with no
 * home-device samples > GAP_THRESHOLD_MS, incl. the restart-spanning variant that
 * catches a host power loss / add-on stop) into its gaps sidecar — but nothing
 * surfaced them to the operator. This turns each recent recorded gap into a
 * push-worthy alert so the operator is FLAGGED when the alarm system went dark
 * (e.g. the ~daily Pi power cut), and can tell whether a hardware fix — a UPS
 * firmware update, moving the Pi to an always-on circuit — actually stopped them.
 *
 * It is an EVENT, not a sustained condition: the outage is already over by the
 * time we detect it (writes resumed / the process rebooted). So it FIRES ONCE per
 * distinct gap (stable id `system-outage-<startMs>`), stays visible in the alert
 * list for a recent window, then ages off — and it is exempt from "Resolved:"
 * pushes (isOutageEventFamily), since an event doesn't "recover". Severity is
 * WARNING (routes to the push channel, operator-actionable) but NOT critical —
 * there is nothing to do in the moment; it's a retrospective flag. */

/** Stable id prefix so the same gap never re-alerts and the resolve path can
 *  exempt it. Keyed on the gap's startMs (immutable per gap, survives restarts
 *  via the sidecar). */
export function outageAlertId(startMs: number): string {
  return `system-outage-${startMs}`;
}

/** An outage EVENT alert never sends a "Resolved:" push — it ages off silently. */
export function isOutageEventFamily(alert: Pick<Alert, 'id'>): boolean {
  return alert.id.startsWith('system-outage-');
}

export interface OutageAlertOptions {
  /** Only surface gaps DETECTED within this window; older ones have aged off. */
  recentWindowMs: number;
  /** Ignore IN-PROCESS gaps shorter than this (a cloud/MQTT stall while the process stayed up). */
  minDurationMs: number;
  /**
   * v1.13.0 (review F10) — separate, typically LOWER floor for `restartSpanning`
   * gaps. A restart means the alarm was genuinely DOWN, so even a sub-15-min dark
   * window is operator-relevant (an 11-min deploy blackout previously produced no
   * "alarm was dark" alert at all). Optional + omittable: when absent, restart
   * gaps fall back to `minDurationMs` (exact pre-v1.13.0 behavior).
   */
  restartMinDurationMs?: number;
  /** Feature toggle. */
  enabled: boolean;
}

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Build operator alerts from the recorder's recorded telemetry gaps. Pure +
 * exported so the recency / duration / dedup / restart-vs-stall wording is
 * unit-testable. One Alert per qualifying gap, newest first.
 */
export function outageAlerts(
  gaps: Array<{ startMs: number; endMs: number; durationMs: number; detectedAt: number; restartSpanning?: boolean }>,
  nowMs: number,
  opts: OutageAlertOptions,
): Alert[] {
  if (!opts.enabled) return [];
  const out: Alert[] = [];
  for (const g of gaps) {
    if (!Number.isFinite(g.startMs) || !Number.isFinite(g.durationMs)) continue;
    // v1.13.0 (F10) — a restart-spanning gap (the alarm was genuinely DOWN) clears
    // a lower floor than an in-process cloud stall; falls back to minDurationMs when
    // restartMinDurationMs is omitted (pre-v1.13.0 behavior).
    const floorMs = g.restartSpanning === true && opts.restartMinDurationMs != null
      ? opts.restartMinDurationMs
      : opts.minDurationMs;
    if (g.durationMs < floorMs) continue;                           // too short to bother the operator
    if (nowMs - g.detectedAt > opts.recentWindowMs) continue;        // aged out → drops from the list (no resolve push)
    const mins = Math.max(1, Math.round(g.durationMs / 60_000));
    const restart = g.restartSpanning === true;
    out.push({
      id: outageAlertId(g.startMs),
      severity: 'warning',
      category: 'Connectivity',
      device: 'System',
      // Explicit ISA Medium (P3): operator-relevant, but retrospective — not an
      // immediate hardware danger, so it must not read as a High protective limit.
      priority: 'medium',
      title: restart
        ? `System outage — alarm was dark ${mins} min`
        : `Telemetry gap — no data for ${mins} min`,
      detail: restart
        ? `No home telemetry was recorded for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}), spanning a restart — the Pi lost power or the add-on stopped, so the alarm system was OFFLINE for that stretch and this window of history is unrecoverable. If this recurs, the Pi needs an always-on power source (UPS / dedicated circuit).`
        : `No home-device samples reached the recorder for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}) — an MQTT/broker stall; writes have since resumed. History in that window is missing but the process stayed up.`,
      facts: [
        { label: 'Duration', value: `${mins} min` },
        { label: 'Started', value: fmtClock(g.startMs) },
        { label: 'Ended', value: fmtClock(g.endMs) },
        { label: 'Type', value: restart ? 'restart-spanning (power/host)' : 'in-process (MQTT stall)' },
      ],
    });
  }
  // Newest gap first so the most recent outage sorts to the top of its severity band.
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Compact operator-facing rollup of recorded outages over a window — feeds the
 * ha-state tiles / MQTT sensors so the operator can TRACK the trend (did the UPS
 * firmware fix reduce the count?) at a glance, independent of the transient alerts.
 */
export function outageTracking(
  gaps: Array<{ startMs: number; endMs: number; durationMs: number; detectedAt: number; restartSpanning?: boolean }>,
  nowMs: number,
  windowMs: number,
): { count: number; powerOutageCount: number; telemetryGapCount: number; totalMinutes: number; lastEndedMs: number | null; lastDurationMinutes: number | null } {
  const recent = gaps.filter((g) => Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs);
  const totalMs = recent.reduce((s, g) => s + Math.max(0, g.durationMs), 0);
  const last = recent.reduce<null | { endMs: number; durationMs: number }>(
    (acc, g) => (acc == null || g.endMs > acc.endMs ? { endMs: g.endMs, durationMs: g.durationMs } : acc),
    null,
  );
  // v1.4.1 (daytime-review #4) — split the total by cause. A `restartSpanning` gap means the
  // add-on/host itself was DOWN across the gap (a power / reboot event); a non-spanning gap is
  // a cloud/telemetry stall while the process kept running (the DNS/MQTT blips this fleet rides
  // out — see [[project_wifi_loss_root_cause]]). Mixing them made a benign cloud blip read as a
  // "system outage". `count` stays the total (unchanged for existing consumers); the two split
  // counters let the operator answer "was that power, or just the cloud?" at a glance.
  const powerOutageCount = recent.filter((g) => g.restartSpanning === true).length;
  return {
    count: recent.length,
    powerOutageCount,
    telemetryGapCount: recent.length - powerOutageCount,
    totalMinutes: Math.round(totalMs / 60_000),
    lastEndedMs: last?.endMs ?? null,
    lastDurationMinutes: last != null ? Math.max(1, Math.round(last.durationMs / 60_000)) : null,
  };
}
