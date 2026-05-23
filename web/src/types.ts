export interface DpuPack {
  num: number;
  soc: number | null;
  soh: number | null;
  actSoh: number | null;
  inputWatts: number | null;
  outputWatts: number | null;
  temp: number | null;
  cycles: number | null;
  remainTimeMin: number | null;
  packSn: string | null;
  designCapMah: number | null;
  fullCapMah: number | null;
  remainCapMah: number | null;
  accuChgMah: number | null;
  accuDsgMah: number | null;
  cellTemps: number[];
  mosTemps: number[];
  ptcTemps: number[];
  hwBoardTemp: number | null;
  curResTemp: number | null;
  minCellTemp: number | null;
  maxCellTemp: number | null;
  minMosTemp: number | null;
  maxMosTemp: number | null;
  cellVoltagesMv: number[];
  minCellVoltageMv: number | null;
  maxCellVoltageMv: number | null;
  maxVolDiffMv: number | null;
  balanceState: number | null;
  packVoltageMv: number | null;
  adBatVoltageMv: number | null;
  ocvMv: number | null;
}

export interface DpuProjection {
  kind: 'dpu';
  soc: number | null;
  packCount: number | null;
  packs: DpuPack[];
  pvHighWatts: number | null;
  pvLowWatts: number | null;
  pvTotalWatts: number | null;
  pvHighVolts: number | null;
  pvHighAmps: number | null;
  pvLowVolts: number | null;
  pvLowAmps: number | null;
  pvHighErrCode: number | null;
  pvLowErrCode: number | null;
  acInWatts: number | null;
  acOutWatts: number | null;
  acOutFreq: number | null;
  acOutVol: number | null;
  batVol: number | null;
  batAmp: number | null;
  totalInWatts: number | null;
  totalOutWatts: number | null;
  remainTimeMin: number | null;
  mpptHvTemp: number | null;
  mpptLvTemp: number | null;
  splitPhase: { L11: number | null; L12: number | null; L14: number | null; L21: number | null; L22: number | null };
  sysErrCode: number | null;
  emsParaVolMaxMv: number | null;
  emsParaVolMinMv: number | null;
  chgMaxSoc: number | null;
  dsgMinSoc: number | null;
}

export interface Shp2Circuit {
  ch: number;
  name: string;
  watts: number | null;
  setAmp: number | null;
  linkCh: number | null;
  linkMark: boolean;
  loadPriority: number | null;
  loadIsEnable: boolean | null;
}

export interface Shp2PairedCircuit {
  primaryCh: number;
  secondaryCh: number | null;
  name: string;
  watts: number | null;
  breakerAmps: number | null;
  loadPriority: number | null;
  loadIsEnable: boolean | null;
  isSplitPhase: boolean;
}

export interface Shp2EnergySource {
  slot: number;
  sn: string | null;
  batteryPercentage: number | null;
  isConnected: boolean;
  isAcOpen: boolean;
  fullCap: number | null;
  ratePower: number | null;
  emsBatTemp: number | null;
  hwConnect: boolean;
  errorCodeNum: number | null;
}

export interface Shp2Projection {
  kind: 'shp2';
  area: string | null;
  backupBatPercent: number | null;
  backupFullCapWh: number | null;
  backupRemainWh: number | null;
  backupChargeTimeMin: number | null;
  backupDischargeTimeMin: number | null;
  backupReserveSoc: number | null;
  chargeWattPower: number | null;
  circuits: Shp2Circuit[];
  pairedCircuits: Shp2PairedCircuit[];
  sources: Shp2EnergySource[];
  sourceWatts: number[];
  strategy: Shp2Strategy;
}

export interface Shp2ChargeWindow {
  startMinute: number;
  endMinute: number;
}

export interface Shp2TimeTask {
  type: string | null;
  isEnabled: boolean;
  rangeEnabled: boolean;
  timeMode: string | null;
  chargeWatts: number | null;
  chargeCeilingSoc: number | null;
  chargeFloorSoc: number | null;
  windows: Shp2ChargeWindow[];
  slotMinutes: number;
}

export interface Shp2Strategy {
  loadShedEnabled: boolean;
  loadShedConfigured: boolean;
  midPriorityDischargeFloorSoc: number | null;
  backupMode: number | null;
  overloadMode: number | null;
  smartBackupMode: number | null;
  backupReserveSoc: number | null;
  backupReserveEnabled: boolean;
  solarBackupReserveSoc: number | null;
  timeTask: Shp2TimeTask | null;
}

export interface GenericProjection {
  kind: 'generic';
  soc: number | null;
  inWatts: number | null;
  outWatts: number | null;
  pvWatts: number | null;
  acInWatts: number | null;
  acOutWatts: number | null;
  remainTimeMin: number | null;
  temp: number | null;
}

export type Projection = DpuProjection | Shp2Projection | GenericProjection;

export interface DeviceSnapshot {
  sn: string;
  deviceName: string;
  productName: string;
  online: boolean;
  lastUpdated: number;
  lastError?: string;
  projection?: Projection;
}

export type Severity = 'critical' | 'warning' | 'info';

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
  source?: 'threshold' | 'learned';
  /** Subject identity — Core (DPU) number, then pack number, when scoped to one. */
  coreNum?: number | null;
  packNum?: number | null;
  /** Structured statistical breakdown — populated for learned alerts. */
  facts?: AlertFact[];
}

export interface ClearedAlert {
  alert: Alert;
  raisedAt: number;
  clearedAt: number;
  durationMs: number;
}

export interface FleetSnapshot {
  generatedAt: number;
  devices: Record<string, DeviceSnapshot>;
  alerts?: Alert[];
}

export interface ForecastHour {
  ts: number;
  forecastPvW: number;
  forecastLoadW: number;
  cloudCoverPct: number | null;
  ghiWm2: number | null;
  projectedSocPct: number | null;
  modelled: boolean;
}

export interface HourResponse {
  hour: number;
  coeff: number | null;
  r2: number;
  samples: number;
  observedMaxPvW: number;
}

export interface SolarResponseModel {
  hourly: HourResponse[];
  peakCoeff: number;
  pairCount: number;
  historyDays: number;
}

export interface DeviceSolarModel {
  sn: string;
  device: string;
  model: SolarResponseModel;
  hv: SolarResponseModel;
  lv: SolarResponseModel;
}

export interface SoilingEstimate {
  dropPct: number;
  baselineCoeff: number;
  recentCoeff: number;
  cleanDays: number;
}

export interface DayForecast {
  generatedAt: number;
  hasWeather: boolean;
  historyDays: number;
  reserveSoc: number;
  hours: ForecastHour[];
  forecastPvWhNext24: number;
  typicalPvWhPerDay: number;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
  solarModel: SolarResponseModel;
  deviceModels: DeviceSolarModel[];
  soiling: SoilingEstimate | null;
}

export type DegradeStatus = 'projecting' | 'stable' | 'learning' | 'no-data';

export interface PackDegradation {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  status: DegradeStatus;
  currentSoh: number | null;
  currentCapacityKwh: number | null;
  designCapacityKwh: number | null;
  capacityFadeKwh: number | null;
  cycles: number | null;
  lifetimeThroughputKwh: number | null;
  fadePctPerYear: number | null;
  fadeUncertaintyPct: number | null;
  cyclesPerYear: number | null;
  fadePctPer100Cycles: number | null;
  r2: number | null;
  dataSpanDays: number;
  samples: number;
  yearsToEol: number | null;
  yearsToEolLow: number | null;
  yearsToEolHigh: number | null;
  eolDate: number | null;
  projectedCyclesAtEol: number | null;
  peerFadeRatio: number | null;
  peerOutlier: boolean;
  summary: string;
}

export interface FleetDegradation {
  generatedAt: number;
  eolSoh: number;
  packs: PackDegradation[];
}
