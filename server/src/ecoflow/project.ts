/**
 * Project raw EcoFlow quota maps into compact, UI-ready shapes per product family.
 * Field names below come from probing the user's actual fleet (see /tmp/ecoflow-probe.log).
 */

type Quota = Record<string, unknown>;

const num = (q: Quota, k: string): number | null => {
  const v = q[k];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (q: Quota, k: string): string | null => {
  const v = q[k];
  return v == null ? null : String(v);
};

/** SoC quantisation + REST/MQTT cross-sample jitter slack (mirrors gridState.ts's 1.5 %
 *  boundary slack, widened for the cross-field comparison). */
export const BACKUP_POOL_COHERENCE_SLACK_PCT = 5;

/**
 * v0.54.4 — backup-pool coherence gate. `backupBatPer`, `backupFullCap` and
 * `backupDischargeRmainBatCap` all come from the SAME `backupIncreInfo` aggregate, so a
 * healthy reading is self-consistent: `backupBatPer ≈ remain/full × 100` (live: 28 % vs
 * 25497.6/92160 = 27.7 %). On an SHP2 EcoFlow-cloud reconnect the aggregate can momentarily
 * report a stale/zero member while the pool is really fine — 2026-06-21 18:12 fired the whole
 * 50→2 % SoC-alarm cascade + a broadcast off a transient 0.0 %. When the trio is mutually
 * INCONSISTENT (or incomplete) none of it is trustworthy, so we return all-null ("unknown");
 * every consumer (SoC alarm, on-screen reserve alert, runway projection, MQTT, recorder, TUI)
 * already treats null as "no data" and self-heals on the next poll. NB: a perfectly coherent
 * zero — all three reading ~0 together — is indistinguishable from a real empty pool by a
 * stateless check, so the SoC alarm carries a separate single-tick plausibility guard for it.
 */
export function coherentBackupPool(
  pct: number | null,
  fullCapWh: number | null,
  remainWh: number | null,
): { pct: number | null; fullCapWh: number | null; remainWh: number | null } {
  const untrusted = { pct: null, fullCapWh: null, remainWh: null };
  // Need the full trio (and a real capacity) to cross-check; anything missing → untrusted.
  if (pct == null || fullCapWh == null || fullCapWh <= 0 || remainWh == null) return untrusted;
  const derivedPct = (remainWh / fullCapWh) * 100;
  if (Math.abs(pct - derivedPct) > BACKUP_POOL_COHERENCE_SLACK_PCT) return untrusted;
  return { pct, fullCapWh, remainWh };
}

/** v0.56.0 — grace-hold window for the backup-pool coherence gate. On a brief SHP2 cloud-reconnect
 *  blip the trio reads incoherent for 1–2 ticks; rather than flap the gauge to "unknown" ~10-15×/day,
 *  substitute the LAST coherent trio for up to this long. A SUSTAINED incoherence (real cloud-offline)
 *  outlives the window → falls through to null → the gauge correctly goes unknown. ~3 min is far
 *  longer than a reconnect blip, far shorter than a real outage, and — critically — MUST stay BELOW
 *  the SoC alarm's SLEW_BASELINE_MAX_AGE_MS (10 min) so a hold never makes the alarm baseline stale.
 *  Set to 0 to disable (any elapsed time fails the window check → behaves like before). */
export const BACKUP_POOL_GRACE_HOLD_MS = Math.max(0, Number(process.env.BACKUP_POOL_GRACE_HOLD_MS ?? 180_000));

export interface BackupPoolHold {
  pct: number;
  fullCapWh: number;
  remainWh: number;
  /** wall-clock of the LAST COHERENT reading — the window anchor (NOT refreshed while serving held). */
  atMs: number;
}

/* v0.81.0 — coherent-but-implausible SoC slew guard, at the SHARED backup-pool
 * seam. These MIRROR batterySocAlarm.ts's guard constants (kept in sync via the
 * same env var + literals) — see backupPoolWithGraceHold below for why the guard
 * belongs here, not only in the alarm, and for the SYMMETRIC drop/rise gating. A
 * single-tick backup-pool SoC change larger than BACKUP_POOL_MAX_SLEW_PCT from a
 * FRESH held baseline is physically impossible on the ~92 kWh pool (max ~0.5 %/60 s
 * poll) and is a stale-reconnect artifact. A DROP is rejected only from a HEALTHY
 * (>= BACKUP_POOL_HEALTHY_BASELINE_PCT) baseline — never mask a low near the danger
 * zone; a RISE is rejected regardless of baseline health (holding the lower value
 * can only over-alarm, never mask a low). */
export const BACKUP_POOL_MAX_SLEW_PCT = Number(process.env.BATTERY_SOC_MAX_DROP_PCT ?? 25);
const BACKUP_POOL_HEALTHY_BASELINE_PCT = 30;
const BACKUP_POOL_SLEW_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * v0.56.0 — apply the grace-hold over the coherence-gated trio. `live` is the freshly-gated result
 * from `coherentBackupPool`; `held` is the last coherent trio we stashed (or null). A held value is,
 * by construction, a previously-COHERENT trio — so it can never reintroduce the incoherent zero
 * v0.54.4 was built to suppress, and feeding the SoC alarm a steady held value cannot cascade.
 *   - live coherent          → publish live, refresh the hold (anchor atMs = nowMs).
 *   - live incoherent, hold within window → publish HELD, carry the SAME hold (atMs unchanged so the
 *                                            window keeps closing — else a sustained outage holds forever).
 *   - live incoherent, hold absent/expired → publish null, DROP the hold (gauge goes unknown).
 */
export function backupPoolWithGraceHold(
  live: { pct: number | null; fullCapWh: number | null; remainWh: number | null },
  held: BackupPoolHold | null,
  nowMs: number,
  windowMs: number = BACKUP_POOL_GRACE_HOLD_MS,
): {
  out: { pct: number | null; fullCapWh: number | null; remainWh: number | null };
  hold: BackupPoolHold | null;
  source: 'live' | 'held' | 'none';
} {
  const coherent = live.pct != null && live.fullCapWh != null && live.remainWh != null;
  if (coherent) {
    // v0.81.0 — a coherent read can still be a stale cloud-reconnect ARTIFACT: an
    // internally-consistent pct/remain/full trio that plummets implausibly in one
    // poll (live 2026-07-02: the SHP2 aggregate blipped 44→17→57→35% during a DPU
    // cloud-resync). The coherence gate above can't catch it (all three fields ARE
    // present + consistent). It used to slip through as 'live' → recorded to history
    // AND fed forecast-runtime (which fired a false "1h 21m to reserve" push) — while
    // batterySocAlarm's OWN identical guard correctly rejected it for the SoC ladder.
    // Applying the guard HERE, at the seam every consumer reads, gives the recorder /
    // gauge / forecast the SAME held value the alarm already used — one plausibility
    // guard, not an alarm-only one. It fires only against a FRESH (< max-age) held
    // baseline: a real discharge is gradual and never trips it; a real deep discharge
    // reaches low from an already-low baseline where the DROP half is inactive; and
    // after a genuine long SHP2 offline the held baseline is STALE (> max-age), so a
    // real low-SoC reconnect is HONORED (re-baselined), never masked. `hold` is
    // returned UNCHANGED (atMs not advanced) so a sustained bad value keeps being
    // rejected and it self-heals the instant a real read returns.
    //
    // The guard is SYMMETRIC — it rejects an implausible RISE as well as a drop — but
    // the two directions are gated differently, and that asymmetry is safety-critical:
    //   • DROP (masks a low): allowed to reject ONLY from a HEALTHY baseline
    //     (held.pct ≥ 30). Below the healthy floor we NEVER mask a drop — fail toward
    //     alarming near the danger zone, where a masked low would be an emergency.
    //   • RISE (rejects a high): rejected REGARDLESS of baseline health, no healthy
    //     gate. A > MAX_SLEW rise on the ~92 kWh pool is non-physical (≈1.4 MW), and
    //     holding the LOWER prior value is the conservative direction — it can only
    //     over-alarm, never mask a low. This gate is what stops the v0.81.0 seam
    //     regression an adversarial review found: WITHOUT it, a stale-HIGH cloud
    //     reconnect replay (e.g. the pool genuinely at 8% but the SHP2 backupIncreInfo
    //     replays a coherent 40%) sails through unpoliced (the 8% baseline is below
    //     the healthy floor, so the drop guard is inactive), BECOMES the fresh
    //     "healthy" held, and then arms the drop guard to mask every subsequent REAL
    //     low (6/4/2%) — and because snapshot.ts mutates backupRemainWh through this
    //     seam, that would silence the off-grid runway/floor CRITICAL for up to 10 min
    //     (the last independent low-pool alarm channel).
    if (held != null && nowMs - held.atMs <= BACKUP_POOL_SLEW_MAX_AGE_MS) {
      const drop = held.pct - live.pct!; // > 0 when live is LOWER than the baseline
      const implausibleDrop = held.pct >= BACKUP_POOL_HEALTHY_BASELINE_PCT && drop > BACKUP_POOL_MAX_SLEW_PCT;
      const implausibleRise = -drop > BACKUP_POOL_MAX_SLEW_PCT; // live is > MAX above baseline
      if (implausibleDrop || implausibleRise) {
        return { out: { pct: held.pct, fullCapWh: held.fullCapWh, remainWh: held.remainWh }, hold: held, source: 'held' };
      }
    }
    return { out: live, hold: { pct: live.pct!, fullCapWh: live.fullCapWh!, remainWh: live.remainWh!, atMs: nowMs }, source: 'live' };
  }
  if (held && nowMs - held.atMs <= windowMs) {
    return { out: { pct: held.pct, fullCapWh: held.fullCapWh, remainWh: held.remainWh }, hold: held, source: 'held' };
  }
  return { out: { pct: null, fullCapWh: null, remainWh: null }, hold: null, source: 'none' };
}

/**
 * v0.33.0 — derive a Delta Pro Ultra's WHOLE-UNIT battery DC current from its
 * per-pack power. The `hs_yj751_pd_backend_addr.batAmp` register reads only a
 * fraction of the true current (live: ~3–7 A while the packs were delivering
 * ~28 A worth of AC; the ratio isn't even a clean per-pack divisor, so it can't
 * just be scaled). The per-pack `inputWatts`/`outputWatts` ARE accurate — they
 * sum to the unit's AC output — so net battery DC power = Σ(inputWatts) −
 * Σ(outputWatts) and batAmp = that ÷ batVol. Sign matches the register: charging
 * (input dominant) → positive, discharging → negative. Falls back to the raw
 * register only when pack power or batVol is unavailable. This is the series the
 * internal-resistance model reads (`bat_amp`), which the under-read register was
 * skewing ~4–7×.
 */
export function deriveWholeUnitBatAmp(
  packInOut: Array<{ inputWatts: number | null; outputWatts: number | null }>,
  batVol: number | null,
  fallbackAmp: number | null,
): number | null {
  let netW = 0;
  let have = false;
  for (const p of packInOut) {
    if (p.inputWatts != null) { netW += p.inputWatts; have = true; }
    if (p.outputWatts != null) { netW -= p.outputWatts; have = true; }
  }
  if (have && batVol != null && batVol > 1) return Math.round((netW / batVol) * 100) / 100;
  return fallbackAmp;
}

export interface DpuPack {
  num: number;
  soc: number | null;
  soh: number | null;
  actSoh: number | null;        // float SoH (e.g. 98.00781) — more precise than soh integer
  inputWatts: number | null;
  outputWatts: number | null;
  temp: number | null;
  cycles: number | null;
  remainTimeMin: number | null;
  packSn: string | null;
  // Capacity (single-string mAh). Each pack is 32S1P (~104 V nominal; 32 series
  // cells whose mV sum to packVoltageMv). Wh = mAh × (32 × 3.2 V) / 1000 = mAh × 0.1024.
  designCapMah: number | null;
  fullCapMah: number | null;
  remainCapMah: number | null;
  accuChgMah: number | null;    // lifetime mAh charged
  accuDsgMah: number | null;    // lifetime mAh discharged
  // Thermal detail (Celsius — UI converts to Fahrenheit)
  cellTemps: number[];      // 7 cells per pack
  mosTemps: number[];       // 4 MOSFETs
  ptcTemps: number[];       // 4 PTC heaters
  hwBoardTemp: number | null;
  curResTemp: number | null;
  minCellTemp: number | null;
  maxCellTemp: number | null;
  minMosTemp: number | null;
  maxMosTemp: number | null;
  // Per-cell voltage detail (millivolts — UI converts to V).
  // DPU packs report 32 cells (32S1P: 32 series cells whose mV sum to packVoltageMv).
  cellVoltagesMv: number[];
  minCellVoltageMv: number | null;
  maxCellVoltageMv: number | null;
  maxVolDiffMv: number | null;   // BMS-reported (≈ max - min)
  balanceState: number | null;   // 0 = idle, non-zero = balancing (bitmask of which cells)
  packVoltageMv: number | null;  // pack-level vol field
  adBatVoltageMv: number | null; // measured battery vol
  ocvMv: number | null;          // open-circuit voltage (65535 when unknown)
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
  // EcoFlow-provided operating limits (not health alarms — those are internal to the BMS)
  emsParaVolMaxMv: number | null; // EMS parallel-operation pack-voltage ceiling
  emsParaVolMinMv: number | null; // EMS parallel-operation pack-voltage floor
  chgMaxSoc: number | null;       // configured charge ceiling %
  dsgMinSoc: number | null;       // configured discharge floor %
}

export function projectDpu(q: Quota): DpuProjection {
  const packs: DpuPack[] = [];
  for (let i = 1; i <= 5; i++) {
    const base = `hs_yj751_bms_slave_addr.${i}.`;
    if (q[`${base}soc`] === undefined && q[`${base}packSn`] === undefined) continue;
    const cellTempsRaw = q[`${base}cellTemp`];
    const mosTempsRaw = q[`${base}mosTemp`];
    const ptcTempsRaw = q[`${base}ptcTemp`];
    const cellVolRaw = q[`${base}cellVol`];
    // OCV often arrives as 65535 (uint16 "unknown" sentinel); normalize to null.
    const rawOcv = num(q, `${base}ocv`);
    const ocvMv = rawOcv != null && rawOcv < 65000 ? rawOcv : null;
    packs.push({
      num: i,
      soc: num(q, `${base}soc`),
      soh: num(q, `${base}soh`),
      actSoh: num(q, `${base}actSoh`),
      inputWatts: num(q, `${base}inputWatts`),
      outputWatts: num(q, `${base}outputWatts`),
      temp: num(q, `${base}temp`),
      cycles: num(q, `${base}cycles`),
      remainTimeMin: num(q, `${base}remainTime`),
      packSn: str(q, `${base}packSn`),
      designCapMah: num(q, `${base}designCap`),
      fullCapMah: num(q, `${base}fullCap`),
      remainCapMah: num(q, `${base}remainCap`),
      accuChgMah: num(q, `${base}accuChgCap`),
      accuDsgMah: num(q, `${base}accuDsgCap`),
      cellTemps: Array.isArray(cellTempsRaw) ? (cellTempsRaw as number[]) : [],
      mosTemps: Array.isArray(mosTempsRaw) ? (mosTempsRaw as number[]) : [],
      ptcTemps: Array.isArray(ptcTempsRaw) ? (ptcTempsRaw as number[]) : [],
      hwBoardTemp: num(q, `${base}hwBoardTemp`),
      curResTemp: num(q, `${base}curResTemp`),
      minCellTemp: num(q, `${base}minCellTemp`),
      maxCellTemp: num(q, `${base}maxCellTemp`),
      minMosTemp: num(q, `${base}minMosTemp`),
      maxMosTemp: num(q, `${base}maxMosTemp`),
      cellVoltagesMv: Array.isArray(cellVolRaw) ? (cellVolRaw as number[]) : [],
      minCellVoltageMv: num(q, `${base}minCellVol`),
      maxCellVoltageMv: num(q, `${base}maxCellVol`),
      maxVolDiffMv: num(q, `${base}maxVolDiff`),
      balanceState: num(q, `${base}balanceState`),
      packVoltageMv: num(q, `${base}vol`),
      adBatVoltageMv: num(q, `${base}adBatVol`),
      ocvMv,
    });
  }
  const pvHigh = num(q, 'hs_yj751_pd_appshow_addr.inHvMpptPwr');
  const pvLow = num(q, 'hs_yj751_pd_appshow_addr.inLvMpptPwr');
  return {
    kind: 'dpu',
    soc: num(q, 'hs_yj751_pd_appshow_addr.soc'),
    packCount: num(q, 'hs_yj751_pd_appshow_addr.bpNum'),
    packs,
    pvHighWatts: pvHigh,
    pvLowWatts: pvLow,
    pvTotalWatts: pvHigh != null || pvLow != null ? (pvHigh ?? 0) + (pvLow ?? 0) : null,
    pvHighVolts: num(q, 'hs_yj751_pd_backend_addr.inHvMpptVol'),
    pvHighAmps: num(q, 'hs_yj751_pd_backend_addr.inHvMpptAmp'),
    pvLowVolts: num(q, 'hs_yj751_pd_backend_addr.inLvMpptVol'),
    pvLowAmps: num(q, 'hs_yj751_pd_backend_addr.inLvMpptAmp'),
    pvHighErrCode: num(q, 'hs_yj751_pd_backend_addr.hvPvErrCode'),
    pvLowErrCode: num(q, 'hs_yj751_pd_backend_addr.lvPvErrCode'),
    acInWatts: (num(q, 'hs_yj751_pd_appshow_addr.inAc5p8Pwr') ?? 0) + (num(q, 'hs_yj751_pd_appshow_addr.inAcC20Pwr') ?? 0),
    acOutWatts: num(q, 'hs_yj751_pd_appshow_addr.outAc5p8Pwr'),
    acOutFreq: num(q, 'hs_yj751_pd_backend_addr.acOutFreq'),
    acOutVol: num(q, 'hs_yj751_pd_backend_addr.outAc5p8Vol'),
    batVol: num(q, 'hs_yj751_pd_backend_addr.batVol'),
    // v0.33.0 — whole-unit current derived from per-pack power; the raw
    // hs_yj751_pd_backend_addr.batAmp register under-reads by ~4–7×.
    batAmp: deriveWholeUnitBatAmp(packs, num(q, 'hs_yj751_pd_backend_addr.batVol'), num(q, 'hs_yj751_pd_backend_addr.batAmp')),
    totalInWatts: num(q, 'hs_yj751_pd_appshow_addr.wattsInSum'),
    totalOutWatts: num(q, 'hs_yj751_pd_appshow_addr.wattsOutSum'),
    remainTimeMin: num(q, 'hs_yj751_pd_appshow_addr.remainTime'),
    mpptHvTemp: num(q, 'hs_yj751_pd_backend_addr.mpptHvTemp'),
    mpptLvTemp: num(q, 'hs_yj751_pd_backend_addr.mpptLvTemp'),
    splitPhase: {
      L11: num(q, 'hs_yj751_pd_appshow_addr.outAcL11Pwr'),
      L12: num(q, 'hs_yj751_pd_appshow_addr.outAcL12Pwr'),
      L14: num(q, 'hs_yj751_pd_appshow_addr.outAcL14Pwr'),
      L21: num(q, 'hs_yj751_pd_appshow_addr.outAcL21Pwr'),
      L22: num(q, 'hs_yj751_pd_appshow_addr.outAcL22Pwr'),
    },
    sysErrCode: num(q, 'hs_yj751_pd_appshow_addr.sysErrCode'),
    emsParaVolMaxMv: num(q, 'hs_yj751_pd_backend_addr.emsParaVolMax'),
    emsParaVolMinMv: num(q, 'hs_yj751_pd_backend_addr.emsParaVolMin'),
    chgMaxSoc: num(q, 'hs_yj751_pd_app_set_info_addr.chgMaxSoc'),
    dsgMinSoc: num(q, 'hs_yj751_pd_app_set_info_addr.dsgMinSoc'),
  };
}

export interface Shp2Circuit {
  ch: number;
  name: string;
  watts: number | null;
  setAmp: number | null;
  linkCh: number | null;     // sibling channel for a double-pole 240V load (null when single-pole)
  linkMark: boolean;          // SHP2-reported "this is a paired leg" flag
  loadPriority: number | null;
  loadIsEnable: boolean | null;
}

export interface Shp2PairedCircuit {
  primaryCh: number;          // smaller channel number; carries the user-set name
  secondaryCh: number | null; // null for true single-pole circuits
  name: string;               // name from primary leg
  watts: number | null;       // sum of both legs
  breakerAmps: number | null; // breaker rating from primary leg
  // SHP2 native loadPriority: ASCENDING = most-protected (shed LAST); the HIGHEST
  // number sheds FIRST. Verified empirically against live data: Pool Pump — the
  // canonical least-essential load, currently SHP2-disabled — carries loadPriority
  // 25, while a subpanel carries 1. This is the OPPOSITE polarity of
  // loadShedRegistry.ts's internal HA shed-list convention (priority 1 = shed-FIRST).
  // They are DIFFERENT priority systems — do NOT unify them or "fix" one to match
  // the other.
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
  /** v0.40.1 — OBSERVABILITY ONLY (set by snapshotForClient / read inline by the
   *  TUI via isSourceDpuStale): the SHP2 still counts this slot's battery in the
   *  backup pool, but the slot's underlying DPU is itself cloud-offline (its own
   *  telemetry is stale). Does NOT affect backup-capacity or the floor alarm. */
  dpuStale?: boolean;
}

export interface Shp2ChargeWindow {
  startMinute: number; // minutes from local midnight
  endMinute: number;
}

export interface Shp2TimeTask {
  type: string | null;        // e.g. CHARGE_TIME_TASK
  isEnabled: boolean;         // whole task on/off
  rangeEnabled: boolean;      // time-range enabled
  timeMode: string | null;    // e.g. STARTEGY_EVERY_DAY
  chargeWatts: number | null;
  chargeCeilingSoc: number | null; // hightBattery
  chargeFloorSoc: number | null;   // lowBattery
  windows: Shp2ChargeWindow[];     // decoded active windows
  slotMinutes: number;             // resolution of each bitmap slot
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
  /** v0.34.0 — total grid power into the home at the SHP2 main (wattInfo.gridWatt).
   *  The authoritative whole-home grid import. DPU `ac_in` only captures grid that
   *  charges the DPUs, missing grid that serves home loads directly through the
   *  panel — which is why home load didn't reconcile against PV + DPU-ac_in grid. */
  gridWatt: number | null;
  strategy: Shp2Strategy;
}

/**
 * Decode the SHP2 timeScale.sta bitmap — an array of base64-encoded bytes,
 * each bit a time slot across the 24h day, into contiguous active windows.
 * 18 bytes × 8 bits = 144 slots → 10-minute resolution. Bits are MSB-first
 * within each byte (bit 7 = earliest slot of that byte).
 */
function decodeTimeScale(sta: unknown): { windows: Shp2ChargeWindow[]; slotMinutes: number } {
  if (!Array.isArray(sta) || sta.length === 0) return { windows: [], slotMinutes: 10 };
  const bits: boolean[] = [];
  for (const entry of sta) {
    if (typeof entry !== 'string') continue;
    // Iterate EVERY byte of the decoded entry, not just the first — a multi-byte
    // base64 entry must contribute all its slots. Bit order is preserved MSB-first
    // within each byte (bit 7 = earliest slot). For today's single-byte entries this
    // is identical to the old `[0]`-only path (verified against the live timeScale.sta
    // bitmap: windows decode the same 640–880 / 940–960).
    const buf = Buffer.from(entry, 'base64');
    for (const byte of buf) {
      for (let b = 7; b >= 0; b--) bits.push(((byte >> b) & 1) === 1);
    }
  }
  const totalSlots = bits.length || 144;
  const slotMinutes = Math.round((24 * 60) / totalSlots) || 10;
  const windows: Shp2ChargeWindow[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] && runStart == null) runStart = i;
    if (!bits[i] && runStart != null) {
      windows.push({ startMinute: runStart * slotMinutes, endMinute: i * slotMinutes });
      runStart = null;
    }
  }
  if (runStart != null) {
    windows.push({ startMinute: runStart * slotMinutes, endMinute: bits.length * slotMinutes });
  }
  return { windows, slotMinutes };
}

function projectShp2Strategy(q: Quota): Shp2Strategy {
  const taskType = str(q, 'pd303_mc.TimeTaskCfg1.comCfg.type');
  let timeTask: Shp2TimeTask | null = null;
  if (taskType || q['pd303_mc.TimeTaskCfg1.comCfg.isCfg'] === true) {
    const decoded = decodeTimeScale(q['pd303_mc.TimeTaskCfg1.comCfg.timeScale.sta']);
    timeTask = {
      type: taskType,
      isEnabled: q['pd303_mc.TimeTaskCfg1.comCfg.isEnable'] === true,
      rangeEnabled: q['pd303_mc.TimeTaskCfg1.comCfg.timeRange.isEnable'] === true,
      timeMode: str(q, 'pd303_mc.TimeTaskCfg1.comCfg.timeRange.timeMode'),
      chargeWatts: num(q, 'pd303_mc.TimeTaskCfg1.chargeCfg.chChargeWatt'),
      chargeCeilingSoc: num(q, 'pd303_mc.TimeTaskCfg1.chargeCfg.hightBattery'),
      chargeFloorSoc: num(q, 'pd303_mc.TimeTaskCfg1.chargeCfg.lowBattery'),
      windows: decoded.windows,
      slotMinutes: decoded.slotMinutes,
    };
  }
  return {
    loadShedEnabled: q['pd303_mc.LoadStrategyCfg.isEnable'] === true,
    loadShedConfigured: num(q, 'pd303_mc.LoadStrategyCfg.isCfg') === 1,
    midPriorityDischargeFloorSoc: num(q, 'pd303_mc.LoadStrategyCfg.midPriorityChDischargeLow'),
    backupMode: num(q, 'pd303_mc.LoadStrategyCfg.backupMode'),
    overloadMode: num(q, 'pd303_mc.LoadStrategyCfg.overloadMode'),
    smartBackupMode: num(q, 'pd303_mc.smartBackupMode') ?? num(q, 'smartBackupMode'),
    // MUST decode the SAME reserve the floor alarm defends with. The alarm
    // (alerts.ts), grid-backstop (gridState.ts), the HA backup_reserve_percent
    // sensor and analytics all read the top-level projection.backupReserveSoc,
    // which is the FLAT `backupReserveSoc` key only (see projectShp2 below). Keep
    // this strategy-tile field decoded identically so the Strategy page can never
    // show a reserve different from the one actually protecting the home — do NOT
    // re-introduce a pd303_mc.* preference here without changing the alarm too.
    backupReserveSoc: num(q, 'backupReserveSoc'),
    backupReserveEnabled: num(q, 'pd303_mc.backupReserveEnable') === 1,
    solarBackupReserveSoc: num(q, 'pd303_mc.solarBackupReserveSoc'),
    timeTask,
  };
}

export function projectShp2(q: Quota): Shp2Projection {
  // Live per-circuit watts come as a JSON array (already an array from REST).
  const hall1Watt = Array.isArray(q['loadInfo.hall1Watt'])
    ? (q['loadInfo.hall1Watt'] as number[])
    : [];
  const strategyCfg = Array.isArray(q['pd303_mc.LoadStrategyCfg.hall1ChInfo'])
    ? (q['pd303_mc.LoadStrategyCfg.hall1ChInfo'] as Array<{ loadPriority?: number; loadIsEnable?: boolean }>)
    : [];
  const circuits: Shp2Circuit[] = [];
  for (let i = 1; i <= 12; i++) {
    const base = `loadIncreInfo.hall1IncreInfo.ch${i}Info.`;
    const splitBase = `pd303_mc.loadIncreInfo.hall1IncreInfo.ch${i}Info.splitphase.`;
    const name = str(q, `${base}chName`) ?? `Circuit ${i}`;
    const linkCh = num(q, `${splitBase}linkCh`);
    const cfg = strategyCfg[i - 1];
    circuits.push({
      ch: i,
      name,
      watts: typeof hall1Watt[i - 1] === 'number' ? hall1Watt[i - 1] : null,
      setAmp: num(q, `${base}setAmp`),
      linkCh: linkCh && linkCh > 0 && linkCh !== i ? linkCh : null,
      linkMark: q[`${splitBase}linkMark`] === true,
      loadPriority: cfg?.loadPriority ?? null,
      loadIsEnable: cfg?.loadIsEnable ?? null,
    });
  }
  // Build paired-circuit groups. Primary = smaller ch in a linked pair.
  const handled = new Set<number>();
  const pairedCircuits: Shp2PairedCircuit[] = [];
  for (const c of circuits) {
    if (handled.has(c.ch)) continue;
    if (c.linkCh != null && c.linkMark) {
      const primaryCh = Math.min(c.ch, c.linkCh);
      const secondaryCh = Math.max(c.ch, c.linkCh);
      const primary = circuits.find((x) => x.ch === primaryCh)!;
      const secondary = circuits.find((x) => x.ch === secondaryCh);
      const sumWatts =
        primary.watts != null || secondary?.watts != null
          ? (primary.watts ?? 0) + (secondary?.watts ?? 0)
          : null;
      pairedCircuits.push({
        primaryCh,
        secondaryCh,
        name: primary.name,
        watts: sumWatts,
        breakerAmps: primary.setAmp,
        loadPriority: primary.loadPriority,
        loadIsEnable: primary.loadIsEnable,
        isSplitPhase: true,
      });
      handled.add(primaryCh);
      if (secondaryCh) handled.add(secondaryCh);
    } else {
      pairedCircuits.push({
        primaryCh: c.ch,
        secondaryCh: null,
        name: c.name,
        watts: c.watts,
        breakerAmps: c.setAmp,
        loadPriority: c.loadPriority,
        loadIsEnable: c.loadIsEnable,
        isSplitPhase: false,
      });
      handled.add(c.ch);
    }
  }
  const sources: Shp2EnergySource[] = [];
  for (let i = 1; i <= 3; i++) {
    const base = `pd303_mc.backupIncreInfo.Energy${i}Info.`;
    sources.push({
      slot: i,
      sn: str(q, `${base}devInfo.modelInfo.sn`),
      batteryPercentage: num(q, `${base}batteryPercentage`),
      isConnected: num(q, `${base}isConnect`) === 1,
      isAcOpen: num(q, `${base}isAcOpen`) === 1,
      fullCap: num(q, `${base}devInfo.fullCap`),
      ratePower: num(q, `${base}devInfo.ratePower`),
      emsBatTemp: num(q, `${base}emsBatTemp`),
      hwConnect: num(q, `${base}hwConnect`) === 1,
      errorCodeNum: num(q, `${base}errorCodeNum`),
    });
  }
  const sourceWatts = Array.isArray(q['backupInfo.chWatt'])
    ? (q['backupInfo.chWatt'] as number[])
    : [];

  // v0.54.4 — gate the backup-pool trio on mutual coherence before it reaches any consumer,
  // so a transient stale/zero member on an SHP2 cloud reconnect can't fire a false SoC-alarm
  // cascade / runway-critical / reserve alert. Incoherent ⇒ all-null (unknown), self-heals.
  const pool = coherentBackupPool(
    num(q, 'backupIncreInfo.backupBatPer'),
    num(q, 'backupIncreInfo.backupFullCap'),
    num(q, 'backupIncreInfo.backupDischargeRmainBatCap'),
  );

  return {
    kind: 'shp2',
    area: str(q, 'pd303_mc.area'),
    backupBatPercent: pool.pct,
    backupFullCapWh: pool.fullCapWh,
    backupRemainWh: pool.remainWh,
    backupChargeTimeMin: num(q, 'backupInfo.backupChargeTime'),
    backupDischargeTimeMin: num(q, 'backupInfo.backupDischargeTime'),
    backupReserveSoc: num(q, 'backupReserveSoc'),
    chargeWattPower: num(q, 'chargeWattPower'),
    circuits,
    pairedCircuits,
    sources,
    sourceWatts,
    gridWatt: num(q, 'wattInfo.gridWatt'),
    strategy: projectShp2Strategy(q),
  };
}

/** Generic small-device projection used for D3+, R3+, EVSE, and anything else we don't have a tailored shape for. */
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
  raw: Quota;
}

export function projectGeneric(q: Quota): GenericProjection {
  // Try a handful of common field names across small EcoFlow units.
  const findFirst = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = num(q, k);
      if (v != null) return v;
    }
    return null;
  };
  return {
    kind: 'generic',
    soc: findFirst('bmsMaster.soc', 'bms_bmsStatus.soc', 'pd.soc', 'bmsBattSoc'),
    inWatts: findFirst('pd.wattsInSum', 'inv.inputWatts', 'pd.inWatts'),
    outWatts: findFirst('pd.wattsOutSum', 'inv.outputWatts', 'pd.outWatts'),
    pvWatts: findFirst('mppt.inWatts', 'pd.solarInWatts'),
    acInWatts: findFirst('inv.acInWatts', 'inv.inAcWatts'),
    acOutWatts: findFirst('inv.outputWatts', 'inv.acOutWatts'),
    remainTimeMin: findFirst('pd.remainTime', 'bmsMaster.remainCap'),
    temp: findFirst('bmsMaster.temp', 'pd.tempSys', 'inv.tempInv'),
    raw: q,
  };
}

export type Projection = DpuProjection | Shp2Projection | GenericProjection;

export function projectByProduct(productName: string | null | undefined, q: Quota): Projection {
  const p = (productName ?? '').toLowerCase();
  if (p.includes('delta pro ultra')) return projectDpu(q);
  if (p.includes('smart home panel')) return projectShp2(q);
  return projectGeneric(q);
}
