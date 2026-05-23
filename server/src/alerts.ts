import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';

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
  /** Subject identity — Core (DPU) number, then pack number, when scoped to one. */
  coreNum?: number | null;
  packNum?: number | null;
  /** Structured statistical breakdown — populated for learned alerts. */
  facts?: AlertFact[];
}

const cToF = (c: number) => c * 1.8 + 32;

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
const SOH_WARN_PCT = 85;
const SOH_CRIT_PCT = 75;
const PACK_SOC_LOW_PCT = 10;
const PACK_IMBALANCE_WARN_PCT = 15;
const STALE_MS = 3 * 60 * 1000;
const CIRCUIT_BREAKER_WARN_FRAC = 0.9;

const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

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

export function computeAlerts(devices: Record<string, DeviceSnapshot>): Alert[] {
  const out: Alert[] = [];
  const list = Object.values(devices);
  const now = Date.now();

  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  // Grid-tied = AC input on an SHP2-bound DPU (the house's grid path). A spare
  // DPU plugged into a wall to self-charge must NOT register as grid power.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const acIn = dpus
    .filter((d) => d.online && (sourceSns.size === 0 || sourceSns.has(d.sn)))
    .reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  if (acIn < 5) {
    out.push({ id: 'grid-offgrid', severity: 'info', category: 'Grid', device: 'System', title: 'Running off-grid', detail: 'No grid import detected — fully on solar + batteries.' });
  }

  for (const d of list) {
    if (!d.online) {
      const isCore = d.productName.toLowerCase().includes('delta pro ultra');
      const isPanel = d.productName.toLowerCase().includes('smart home panel');
      out.push({ id: `offline-${d.sn}`, severity: isCore || isPanel ? 'warning' : 'info', category: 'Connectivity', device: d.deviceName, title: 'Device offline', detail: `${d.deviceName} is not reporting to EcoFlow.`, coreNum: isCore ? dpuNum(d.deviceName) : null });
    } else if (d.projection && d.lastUpdated && now - d.lastUpdated > STALE_MS) {
      out.push({ id: `stale-${d.sn}`, severity: 'warning', category: 'Connectivity', device: d.deviceName, title: 'Telemetry stale', detail: `No update for ${Math.round((now - d.lastUpdated) / 60000)} min — last telemetry is old.`, coreNum: d.productName.toLowerCase().includes('delta pro ultra') ? dpuNum(d.deviceName) : null });
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
    if ((p.pvHighErrCode ?? 0) !== 0) {
      out.push({ id: `dpu-pvh-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'HV MPPT error code', detail: `${d.deviceName} HV solar input reports error code ${p.pvHighErrCode}.` });
    }
    if ((p.pvLowErrCode ?? 0) !== 0) {
      out.push({ id: `dpu-pvl-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'LV MPPT error code', detail: `${d.deviceName} LV solar input reports error code ${p.pvLowErrCode}.` });
    }

    for (const [label, c] of [
      ['HV MPPT', p.mpptHvTemp],
      ['LV MPPT', p.mpptLvTemp],
    ] as const) {
      const a = tempAlert({ idBase: `mppt-${d.sn}-${label}`, device: d.deviceName, label: `${d.deviceName} ${label}`, tempC: c, band: MPPT_TEMP });
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
        if (pk.maxVolDiffMv >= VOL_DIFF_CRIT_MV) {
          out.push({ id: `vdiff-crit-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Cell imbalance', detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (critical ≥ ${VOL_DIFF_CRIT_MV} mV).${balanceNote}` });
        } else if (pk.maxVolDiffMv >= VOL_DIFF_WARN_MV) {
          out.push({ id: `vdiff-warn-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Cell imbalance', detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (warning ≥ ${VOL_DIFF_WARN_MV} mV).${balanceNote}` });
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
  }

  if (shp2?.online && shp2.projection) {
    const sp = shp2.projection;
    const reserve = sp.backupReserveSoc ?? 15;
    if (sp.backupBatPercent != null) {
      if (sp.backupBatPercent < reserve) {
        out.push({ id: 'shp2-below-reserve', severity: 'critical', category: 'SHP2', device: shp2.deviceName, title: 'Backup below reserve', detail: `Backup pool ${sp.backupBatPercent}% is under the ${reserve}% reserve floor.` });
      } else if (sp.backupBatPercent < reserve + 10) {
        out.push({ id: 'shp2-near-reserve', severity: 'warning', category: 'SHP2', device: shp2.deviceName, title: 'Backup approaching reserve', detail: `Backup pool ${sp.backupBatPercent}% is close to the ${reserve}% reserve floor.` });
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

  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
}

export function alertCounts(alerts: Alert[]): Record<Severity, number> {
  return {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
  };
}
