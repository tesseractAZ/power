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
  /** v0.40.1 — observability only: SHP2 still counts this slot's battery, but its
   *  underlying DPU is itself cloud-offline (stale telemetry). Capacity unaffected. */
  dpuStale?: boolean;
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
  /** v0.34.0 — total whole-home grid power into the home at the SHP2 main
   *  (wattInfo.gridWatt). The authoritative grid-import figure; DPU `acInWatts`
   *  only captures grid that charges the DPUs, not grid serving home loads directly. */
  gridWatt: number | null;
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
  // v0.37.0 — the SHP2 device carries its own grid backstop + off_grid flag,
  // attached server-side by snapshotForClient(). GridBackstop is defined below.
  grid?: GridBackstop;
  off_grid?: boolean;
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
  /**
   * v0.44.0 — explicit ISA priority/tier. When present, priorityOf() reads this
   * FIRST and skips the severity+source heuristic (keeps it in lockstep with the
   * server). Lets a real measured threshold crossing reach ISA Medium without
   * faking source='learned'.
   */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /**
   * When `false`, this alert is suppressed from chime/push/broadcast but still
   * shown on the Alerts page (e.g. a spare DPU's offline alarm, or a home core
   * that's actively balancing). `undefined`/`true` annunciate normally. Rendered
   * as a muted "silenced" badge — NOT a "spare" tag, since a balancing home core
   * also lands here.
   */
  annunciate?: boolean;
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

// v0.36.0 — mirrors the server's GridBackstop (server/src/gridState.ts),
// surfaced on the fleet snapshot as `snapshot.grid`. The dashboard cards
// (EnergyFlow, Shp2Card) render a 3-state grid-supply indicator from it.
export interface GridBackstop {
  present: boolean;
  backstopping: boolean;
  importLive: boolean;
  declared: boolean;
  importWatts: number;
  homeGridWatts: number;
  reason: string;
}

export interface FleetSnapshot {
  generatedAt: number;
  devices: Record<string, DeviceSnapshot>;
  alerts?: Alert[];
  grid?: GridBackstop;
  off_grid?: boolean;
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
  // v0.75.0 — home-core coverage basis for this forecast. When a wired home Core
  // is cloud-offline the PV / projected-low-SoC is computed from a degraded basis;
  // the card shows a calm "Forecast basis: N of M home Cores reporting" caveat when
  // homeDpusCoveragePartial is true. Optional for back-compat with older servers.
  homeDpusConnected?: number;
  homeDpusReporting?: number;
  homeDpusCoveragePartial?: boolean;
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
  avgPackTempC: number | null;
  arrheniusFactor: number | null;
  fadePctPerYearAt25C: number | null;
  coolingBenefitYears: number | null;
  coulombicEffPct: number | null;
  summary: string;
}

export interface ClippingHour {
  hour: number;
  observedW: number;
  modelW: number | null;
  clippedW: number;
}

export interface ClippingEstimate {
  generatedAt: number;
  todayKwh: number;
  perHour: ClippingHour[];
  arrayPeakW: number;
  hoursAtPeak: number;
}

// v0.9.77 — SoC-saturation curtailment report from /api/curtailment.
export interface OpportunisticLoad {
  id: string;
  name: string;
  estimatedW: number;
  category: 'pool' | 'ev' | 'water' | 'hvac' | 'other';
  description: string;
  fitsInSurplus: boolean;
  haServiceHint: string | null;
}
export interface CurtailmentHour {
  hour: number;
  surplusW: number;
  curtailedKwh: number;
  socAvg: number;
  pvActualW: number;
  pvExpectedW: number;
  loadW: number;
  weatherVerified: boolean;
}
export interface CurtailmentReport {
  generatedAt: number;
  active: boolean;
  currentSurplusW: number;
  current: {
    socAvg: number;
    pvActualW: number;
    pvExpectedW: number | null;
    loadW: number;
    ghiWm2: number | null;
    bayesianSamples: number;
    chargeCeilingPct: number | null;
    saturationThresholdPct: number;
  };
  inactiveReason:
    | null
    | 'soc-too-low'
    | 'pv-too-low'
    | 'no-daylight'
    | 'no-model'
    | 'small-gap'
    | 'pv-exceeds-load'
    | 'no-shp2'
    | 'no-home-dpus';
  todayKwh: number;
  todayHours: CurtailmentHour[];
  recent7dKwh: number;
  recent7dHoursCount: number;
  hourlyHistogram: Array<{ hour: number; avgSurplusW: number; samples: number }>;
  opportunisticLoads: OpportunisticLoad[];
}

export interface RunwayProjection {
  generatedAt: number;
  backupRemainingKwh: number | null;
  backupReserveKwh: number | null;
  backupFullKwh: number | null;
  recentLoadWatts: number;
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  reserveAtMs: number | null;
  emptyAtMs: number | null;
  forecastPvUsedKwh: number;
  loadHorizonKwh: number;
  horizonHours: number;
  unavailable: string | null;
  /** v0.15.21 (web surfaced v0.46.0) — true when the forecast load curve was
   *  implausibly empty and the whole horizon fell back to a flat observed-load
   *  estimate (post-restart worker race). Lower-fidelity than a healthy projection. */
  loadModelDegraded?: boolean;
}

export interface RoundTripDay {
  date: string;
  chargedKwh: number;
  dischargedKwh: number;
  efficiencyPct: number | null;
}

export interface RoundTripEfficiency {
  generatedAt: number;
  windowDays: number;
  daysWithData: number;
  totalChargedKwh: number;
  totalDischargedKwh: number;
  efficiencyPct: number | null;
  perDay: RoundTripDay[];
}

export interface FleetDegradation {
  generatedAt: number;
  eolSoh: number;
  packs: PackDegradation[];
}

export interface CircuitDayTotal {
  date: string;
  dayStartMs: number;
  dayEndMs: number;
  isToday: boolean;
  kwh: number;
  peakW: number;
  peakAtMs: number | null;
  coverageMs: number;
}

export interface CircuitHistory {
  sn: string;
  ch: number;
  days: CircuitDayTotal[];
  summary: {
    daysWithData: number;
    totalKwh: number;
    avgKwh: number;
    peakDay: CircuitDayTotal | null;
    minDay: CircuitDayTotal | null;
  };
}

// v0.7.5 — advanced analytics surfaces
export interface SelfConsumption {
  generatedAt: number;
  windowDays: number;
  pvKwh: number;
  loadKwh: number;
  batteryChargeKwh: number;
  batteryDischargeKwh: number;
  gridImportKwh: number;   // DPU ac_in — grid that CHARGED the DPUs (a subset of total home grid)
  /** v0.34.0 — total whole-home grid import metered at the SHP2 main (grid_home_w). */
  gridToHomeKwh: number;
  /** v0.40.0 — the coverage-GATED whole-home grid term the KPIs use: the SHP2-main
   *  meter when grid_home_w covers the load window, gridImportKwh on a DPU-only
   *  install, and null when an SHP2 home's grid_home_w hasn't accumulated enough
   *  history yet (display it as "—", matching solarFractionOfLoadPct). This is the
   *  figure to SHOW for "grid import" — gridImportKwh (ac_in) reads ~0 whenever the
   *  grid serves home loads directly through the panel rather than charging DPUs. */
  gridForKpiKwh: number | null;
  /** v0.40.0 — grid_home_w coverage as a fraction of panel_load coverage (0..1). */
  gridHomeCoverageFrac: number;
  pvToLoadKwh: number;
  pvToBatteryKwh: number;
  solarFractionOfLoadPct: number | null;
  directUseRatioPct: number | null;
}

export interface ThermalEventCounts {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  warmEvents: number;
  hotEvents: number;
  overheatEvents: number;
  warmHours: number;
  hotHours: number;
  overheatHours: number;
  dataSpanDays: number;
  hardLifeScore: number;
}

export interface FleetThermalEvents {
  generatedAt: number;
  packs: ThermalEventCounts[];
}

export interface MpptString {
  sn: string;
  device: string;
  coreNum: number | null;
  string: 'HV' | 'LV';
  recentEffPct: number | null;
  baselineEffPct: number | null;
  driftPctPts: number | null;
  samples: number;
  spanDays: number;
}

export interface InverterStandby {
  sn: string;
  device: string;
  coreNum: number | null;
  idleWatts: number | null;
  baselineIdleWatts: number | null;
  trendWattsPerWeek: number | null;
  samples: number;
}

export interface EquipmentHealth {
  generatedAt: number;
  mpptStrings: MpptString[];
  inverterStandby: InverterStandby[];
}

export interface ShadeHour {
  hour: number;
  observedW: number;
  expectedW: number;
  shortfallPct: number;
  clearDays: number;
}

export interface ShadeReport {
  generatedAt: number;
  hours: ShadeHour[];
  estTotalKwhPerYear: number;
}

export interface SoilingPerDevice {
  sn: string;
  device: string;
  coreNum: number | null;
  dropPct: number | null;
  cleanDays: number;
  recentCoeff: number | null;
  baselineCoeff: number | null;
}

export interface SoilingDecomposition {
  generatedAt: number;
  perDevice: SoilingPerDevice[];
  perHour: Array<{ hour: number; dropPct: number; samples: number }>;
}

export interface DeviceProductionRatio {
  sn: string;
  device: string;
  coreNum: number | null;
  recentMedianW: number | null;
  fleetMedianW: number | null;
  ratio: number | null;
  modifiedZ: number | null;
  outlier: boolean;
  samples: number;
}

export interface StringMismatchReport {
  generatedAt: number;
  devices: DeviceProductionRatio[];
}

export interface EvSessionPattern {
  sn: string;
  circuit: number;
  dayOfWeek: number;
  startHour: number;
  typicalDurationHours: number;
  typicalWatts: number;
  recurrences: number;
  energyKwh: number;
}

export interface EvWindowPrediction {
  generatedAt: number;
  sessionsObserved: number;
  patterns: EvSessionPattern[];
  upcomingNext24h: Array<{ ts: number; durationHours: number; watts: number; dayOfWeek: number }>;
}

export interface ChargeCurvePack {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  checkpoints: Array<{
    soc: number;
    baselineV: number | null;
    recentV: number | null;
    driftMv: number | null;
    baselineSamples: number;
    recentSamples: number;
  }>;
  meanDriftMv: number | null;
  status: 'baseline' | 'tracking' | 'no-data';
}

export interface ChargeCurveReport {
  generatedAt: number;
  packs: ChargeCurvePack[];
}

export interface InternalResistanceDevice {
  sn: string;
  device: string;
  coreNum: number | null;
  recentMilliohms: number | null;
  baselineMilliohms: number | null;
  trendMilliohmsPerMonth: number | null;
  samples: number;
  status: 'tracking' | 'learning' | 'no-data';
}

export interface InternalResistanceReport {
  generatedAt: number;
  devices: InternalResistanceDevice[];
}

export interface ForecastSkillDay {
  date: string;
  predictedKwh: number;
  actualKwh: number;
  errorKwh: number;
  errorPct: number | null;
}

export interface ForecastSkillReport {
  generatedAt: number;
  days: ForecastSkillDay[];
  meanAbsErrorKwh: number | null;
  meanAbsErrorPct: number | null;
  biasFactor: number | null;
  windowDays: number;
}

export interface AmbientThermalPack {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  ambientCoeff: number | null;
  loadCoeff: number | null;
  intercept: number | null;
  r2: number | null;
  samples: number;
  predictedPeak24hC: number | null;
  predictedPeakAtMs: number | null;
}

export interface AmbientThermalReport {
  generatedAt: number;
  packs: AmbientThermalPack[];
}

export interface ConfidenceSnapshot {
  generatedAt: number;
  degradationMedianR2: number | null;
  solarModelMedianR2: number | null;
  thermalMedianR2: number | null;
  forecastSkillBiasFactor: number | null;
  forecastSkillMaePct: number | null;
}

export interface NwsAlert {
  id: string;
  event: string;
  severity: string;
  certainty: string;
  urgency: string;
  // NWS CAP times (ISO). onset=event begins, effective=message valid,
  // ends=event ends ("in effect until"), expires=message refresh deadline (short,
  // NOT the event end). Show onset→ends; expires is only a fallback. See nws.ts.
  onset: string | null;
  effective: string | null;
  ends: string | null;
  expires: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
}

export interface Incident {
  id: string;
  severity: Severity;
  scope: 'pack' | 'core' | 'category' | 'system';
  coreNum: number | null;
  packNum: number | null;
  category: string;
  title: string;
  device: string;
  alertCount: number;
  alertIds: string[];
  topAlertTitle: string;
  detail: string;
}

export interface AlertActionStats {
  alertId: string;
  title: string;
  severity: Severity;
  category: string;
  riseCount: number;
  medianDurationMs: number;
  longestDurationMs: number;
  shortClearsCount: number;
  downgradedSilenced: boolean;
  lastSeenAt: number | null;
}
