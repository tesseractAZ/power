import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DeviceSnapshot, DpuPack, DpuProjection, Shp2Projection } from '../types';
import { cToF, fmtPct, fmtW, fmtWh, fmtMins } from '../format';
import { sortDevices } from '../sort';
import { shp2ConnectedDpuSns, isShp2Connected } from '../shp2Membership';

// DPU pack capacity is reported in single-string mAh. Each pack is 32S1P (~104 V
// nominal — 32 series LFP cells at ~3.2 V whose mV sum to packVoltageMv), so
// Wh = mAh × 32 × 3.2 V / 1000 = mAh × 0.1024. (32 × 3.2 == 51.2 × 2; the constant
// is unchanged — only the old "16S2P / 51.2 V × 2 strings" description was wrong.)
const MAH_TO_WH = (32 * 3.2) / 1000;
const mahToWh = (mah: number | null | undefined) => (mah == null ? null : mah * MAH_TO_WH);

/* Thermal bands (°F) for LFP cells / supporting electronics. */
const COLD_F = 60;
const WARM_F = 95;
const HOT_F = 113;
const OVER_F = 131;

/* Uniform readout grid — auto-fill keeps every chip the same width so they
   line up in clean columns regardless of how many there are. */
const GRID_COLS = 'repeat(auto-fill, minmax(112px, 1fr))';

/**
 * Status backplates — dark "ink" text on a colored tint. The digits stay
 * high-contrast and legible; the color is carried by the plate, the way an
 * HMI indicator backlight works. Avoids same-hue text-on-tint low contrast.
 */
const BAND = {
  cool: 'text-ink bg-accent/20 border-accent/55',
  ok: 'text-ink bg-ok/20 border-ok/55',
  warm: 'text-ink bg-amber-700/25 border-amber-700/55',
  hot: 'text-ink bg-warn/30 border-warn/60',
  crit: 'text-ink bg-bad/30 border-bad/60',
  info: 'text-ink bg-panel2/80 border-line', // neutral reading, no good/bad status
  none: 'text-muted bg-panel2/50 border-line/60', // no data
};

function tempCellClass(c: number | null | undefined): string {
  if (c == null) return BAND.none;
  const f = cToF(c);
  if (f >= OVER_F) return BAND.crit;
  if (f >= HOT_F) return BAND.hot;
  if (f >= WARM_F) return BAND.warm;
  if (f >= COLD_F) return BAND.ok;
  return BAND.cool;
}

/* Per-sensor thermal bands (°F) — MIRROR server/src/alerts.ts so the UI plate
 * color equals the alarm engine's verdict on the same reading. Supporting
 * electronics run hotter than cells by design, so a normal ~50 °C (122 °F) MPPT
 * must read OK, not HOT (its alarm info threshold is 131 °F). Cells (and the
 * battery-adjacent SHP2 EMS sensor) keep the dedicated cell band, which carries a
 * cold tint cells care about and electronics don't. */
const SENSOR_BANDS_F: Record<'mos' | 'board' | 'shunt' | 'mppt', { info: number; warn: number; crit?: number }> = {
  mos: { info: 104, warn: 131, crit: 149 },
  board: { info: 113, warn: 140, crit: 158 },
  shunt: { info: 113, warn: 140 }, // alerts.ts SHUNT_TEMP has NO critical — its top severity is "warning" at ≥140°F
  mppt: { info: 131, warn: 149, crit: 167 },
};
function tempClassFor(kind: 'cell' | 'ems' | 'mos' | 'board' | 'shunt' | 'mppt', c: number | null | undefined): string {
  if (c == null) return BAND.none;
  if (kind === 'cell' || kind === 'ems') return tempCellClass(c);
  const f = cToF(c);
  const b = SENSOR_BANDS_F[kind];
  if (b.crit != null && f >= b.crit) return BAND.crit; // a sensor with no crit band (shunt) never renders red
  if (f >= b.warn) return BAND.hot;
  if (f >= b.info) return BAND.warm;
  return BAND.ok;
}
function socCellClass(v: number | null | undefined): string {
  if (v == null) return BAND.none;
  if (v >= 50) return BAND.ok;
  if (v >= 25) return BAND.hot;
  return BAND.crit;
}
function sohCellClass(v: number | null | undefined): string {
  if (v == null) return BAND.none;
  if (v >= 95) return BAND.ok;
  if (v >= 85) return BAND.warm;
  if (v >= 75) return BAND.hot;
  return BAND.crit;
}
function spreadCellClass(v: number | null | undefined): string {
  if (v == null) return BAND.none;
  if (v > 50) return BAND.crit;
  if (v > 20) return BAND.hot;
  if (v > 5) return BAND.warm;
  return BAND.ok;
}
function cellDevColor(dev: number): string {
  const a = Math.abs(dev);
  if (a > 50) return BAND.crit;
  if (a > 20) return BAND.hot;
  if (a > 5) return BAND.warm;
  return BAND.ok;
}

function fmtF(c: number | null | undefined): string {
  return c == null ? '—' : `${Math.round(cToF(c))}°F`;
}
/** Voltage reading in mV → V. Adaptive precision: pack-scale vs cell-scale. */
function fmtVolt(mv: number | null | undefined): string {
  if (mv == null) return '—';
  return mv > 10000 ? `${(mv / 1000).toFixed(1)} V` : `${(mv / 1000).toFixed(3)} V`;
}
/** Single SoH formatter shared by the matrix cell AND the detail tile so the same
 *  pack never renders two different numbers. One decimal keeps an above-nameplate
 *  reading visible (e.g. 100.4%) rather than collapsing to a bare "100%". */
function fmtSoh(v: number): string {
  return `${v.toFixed(1)}%`;
}

/* ---- Matrix metric definitions ---- */
type MetricKey = 'temp' | 'soc' | 'soh' | 'imbalance';
interface MetricDef {
  key: MetricKey;
  label: string;
  get: (pk: DpuPack) => number | null;
  fmt: (v: number) => string;
  cell: (v: number | null) => string;
  legend: Array<{ label: string; cls: string }>;
}
const METRICS: MetricDef[] = [
  {
    key: 'temp',
    label: 'Temperature',
    get: (pk) => pk.maxCellTemp ?? pk.temp,
    fmt: (c) => fmtF(c),
    cell: tempCellClass,
    legend: [
      { label: `< ${COLD_F}°`, cls: BAND.cool },
      { label: `${COLD_F}–${WARM_F}°`, cls: BAND.ok },
      { label: `${WARM_F}–${HOT_F}°`, cls: BAND.warm },
      { label: `${HOT_F}–${OVER_F}°`, cls: BAND.hot },
      { label: `≥ ${OVER_F}°`, cls: BAND.crit },
    ],
  },
  {
    key: 'soc',
    label: 'State of charge',
    get: (pk) => pk.soc,
    fmt: (v) => `${Math.round(v)}%`,
    cell: socCellClass,
    legend: [
      { label: '< 25%', cls: BAND.crit },
      { label: '25–50%', cls: BAND.hot },
      { label: '≥ 50%', cls: BAND.ok },
    ],
  },
  {
    key: 'soh',
    label: 'State of health',
    get: (pk) => pk.actSoh ?? pk.soh,
    fmt: (v) => fmtSoh(v),
    cell: sohCellClass,
    legend: [
      { label: '< 75%', cls: BAND.crit },
      { label: '75–85%', cls: BAND.hot },
      { label: '85–95%', cls: BAND.warm },
      { label: '≥ 95%', cls: BAND.ok },
    ],
  },
  {
    key: 'imbalance',
    label: 'Cell imbalance',
    get: (pk) => pk.maxVolDiffMv,
    fmt: (v) => `${Math.round(v)} mV`,
    cell: spreadCellClass,
    legend: [
      { label: '≤ 5 mV', cls: BAND.ok },
      { label: '≤ 20 mV', cls: BAND.warm },
      { label: '≤ 50 mV', cls: BAND.hot },
      { label: '> 50 mV', cls: BAND.crit },
    ],
  },
];

/**
 * Battery page — a control-room "pack matrix": every battery pack across the
 * fleet shown as one cell, color-coded by a selectable metric, click to drill in.
 */
export function ThermalPanel({ devices }: { devices: Record<string, DeviceSnapshot> }) {
  const list = sortDevices(Object.values(devices));
  const dpus = list.filter((d) => d.productName?.toLowerCase().includes('delta pro ultra')) as Array<
    DeviceSnapshot & { projection?: DpuProjection }
  >;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;

  const [metric, setMetric] = useState<MetricKey>('temp');
  const [selected, setSelected] = useState<{ sn: string; num: number } | null>(null);

  const def = METRICS.find((m) => m.key === metric)!;
  const maxPacks = 5;

  const selDpu = selected ? dpus.find((d) => d.sn === selected.sn) : undefined;
  const selPack = selDpu?.projection?.packs.find((pk) => pk.num === selected!.num);

  return (
    <div className="space-y-4">
      <SummaryStrip dpus={dpus} devices={devices} shp2={shp2} />

      {/* Pack matrix */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Fleet pack matrix</span>
          <div className="flex bg-panel2 border border-line rounded-lg overflow-hidden text-xs">
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={`px-3 py-1.5 transition-colors ${
                  metric === m.key ? 'bg-accent/25 text-ink font-semibold' : 'text-muted hover:text-ink'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[680px]">
            {/* Column headers — one per DPU */}
            <div className="grid gap-1.5 mb-1.5" style={{ gridTemplateColumns: `96px repeat(${dpus.length}, 1fr)` }}>
              <div />
              {dpus.map((d) => (
                <div
                  key={d.sn}
                  className={`flex flex-col items-center justify-center min-w-0 text-xs uppercase tracking-widest text-muted ${d.online ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${d.online ? 'bg-ok' : 'bg-bad'}`} />
                    <span className="truncate" title={d.deviceName}>{d.deviceName}</span>
                  </div>
                  {!d.online && <span className="text-[10px] text-bad normal-case tracking-normal">offline</span>}
                </div>
              ))}
            </div>
            {/* One row per pack position */}
            {Array.from({ length: maxPacks }, (_, i) => {
              const num = i + 1;
              return (
                <div
                  key={num}
                  className="grid gap-1.5 mb-1.5"
                  style={{ gridTemplateColumns: `96px repeat(${dpus.length}, 1fr)` }}
                >
                  <div className="flex items-center text-sm font-medium text-muted">Pack {num}</div>
                  {dpus.map((d) => {
                    const pk = d.projection?.packs.find((x) => x.num === num);
                    const raw = pk ? def.get(pk) : null;
                    const isSel = selected?.sn === d.sn && selected?.num === num;
                    const balancing = pk?.balanceState != null && pk.balanceState !== 0;
                    // Secondary reference reading so every cell shows two vitals.
                    const tempVal = pk ? pk.maxCellTemp ?? pk.temp : null;
                    const secondary =
                      metric === 'soc'
                        ? tempVal != null
                          ? fmtF(tempVal)
                          : null
                        : pk?.soc != null
                          ? `${Math.round(pk.soc)}%`
                          : null;
                    const secLabel = metric === 'soc' ? 'temp' : 'SoC';
                    return (
                      <button
                        key={d.sn}
                        type="button"
                        disabled={!pk}
                        onClick={() => setSelected({ sn: d.sn, num })}
                        className={`relative border rounded-md py-2.5 px-1 text-center transition-all ${def.cell(raw)} ${
                          d.online ? '' : 'opacity-50'
                        } ${
                          isSel
                            ? 'ring-2 ring-accent ring-offset-1 ring-offset-panel'
                            : pk
                              ? 'hover:brightness-95'
                              : 'cursor-default'
                        }`}
                      >
                        <div className="text-xl font-semibold tabular-nums leading-none">
                          {raw != null ? def.fmt(raw) : '—'}
                        </div>
                        {secondary != null && (
                          <div className="text-xs tabular-nums leading-none mt-1.5 opacity-70">
                            {secLabel} {secondary}
                          </div>
                        )}
                        {balancing && (
                          <span className="absolute top-1 right-1.5 text-xs" title="balancing">↻</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted uppercase tracking-widest mr-1">{def.label}</span>
          {def.legend.map((l) => (
            <span key={l.label} className={`border rounded px-2 py-1 ${l.cls}`}>{l.label}</span>
          ))}
        </div>
      </div>

      {/* Selected pack detail */}
      {selDpu && selPack ? (
        <div className="card space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-muted">{selDpu.deviceName} · Pack {selPack.num}</div>
              <div className="text-lg font-semibold">
                Pack detail
                {selPack.packSn && (
                  <span className="text-xs font-mono text-muted ml-2 font-normal">{selPack.packSn}</span>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              {selDpu.projection && (
                <>
                  <Readout
                    label="MPPT HV"
                    value={fmtF(selDpu.projection.mpptHvTemp)}
                    cls={tempClassFor('mppt', selDpu.projection.mpptHvTemp)}
                  />
                  <Readout
                    label="MPPT LV"
                    value={fmtF(selDpu.projection.mpptLvTemp)}
                    cls={tempClassFor('mppt', selDpu.projection.mpptLvTemp)}
                  />
                </>
              )}
              <button
                onClick={() => setSelected(null)}
                className="text-muted hover:text-ink text-2xl leading-none px-1.5"
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>
          <PackDetail pk={selPack} />
        </div>
      ) : (
        <div className="card text-sm text-muted">
          Select a pack in the matrix above to see its full cell-voltage, temperature and health detail.
        </div>
      )}

      {/* SHP2 EMS battery temps */}
      {shp2?.projection && (
        <div className="card">
          <div className="card-title">SHP2 EMS battery temps (per source)</div>
          <div className="grid grid-cols-3 gap-3">
            {shp2.projection.sources.map((s) => {
              const dpu = dpus.find((d) => d.sn === s.sn);
              return (
                <div key={s.slot} className={`relative border rounded-md p-3 ${tempClassFor('ems', s.emsBatTemp)} ${s.dpuStale ? 'opacity-60' : ''}`}>
                  <div className="text-xs uppercase tracking-widest opacity-70">Slot {s.slot}</div>
                  <div className="text-sm font-medium truncate">{dpu?.deviceName ?? s.sn ?? '—'}</div>
                  <div className="text-2xl font-semibold tabular-nums mt-1">{fmtF(s.emsBatTemp)}</div>
                  {s.dpuStale && (
                    <span
                      className="absolute top-1.5 right-1.5 text-[10px] uppercase tracking-wide bg-warn/30 text-ink border border-warn/60 rounded px-1.5 py-0.5"
                      title="Core is cloud-offline; its battery is still wired and counted in the pool capacity above."
                    >
                      stale
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Condensed backup-pool battery summary strip ----
 *
 * v0.9.75 — was "fleet battery summary," counting every pack across
 * every DPU on the EcoFlow account. For the operator's 3-of-5-connected setup
 * that overstated total capacity by ~67% (a 5-DPU sum claims ~150 kWh
 * when only ~90 kWh is wired to the home). Now restricted to packs in
 * SHP2-connected DPUs; the label reflects the scope. Hot-pack / spread
 * extremes are also computed from the connected pool — a thermal
 * anomaly on a spare bench unit isn't the home's problem to flag here.
 */
function SummaryStrip({
  dpus,
  devices,
  shp2,
}: {
  dpus: Array<DeviceSnapshot & { projection?: DpuProjection }>;
  devices: Record<string, DeviceSnapshot>;
  shp2?: DeviceSnapshot & { projection: Shp2Projection };
}) {
  const connectedSns = shp2ConnectedDpuSns(devices);
  let packs = 0;
  let socSum = 0, socN = 0;
  let sohSum = 0, sohN = 0;
  let fullMah = 0;
  let designMah = 0;
  let balancing = 0;
  let hottest: { c: number; tag: string } | null = null;
  let worstSpread: { mv: number; tag: string } | null = null;
  for (const d of dpus) {
    if (!d.online || !d.projection) continue;
    if (!isShp2Connected(d.sn, connectedSns)) continue;
    for (const pk of d.projection.packs) {
      packs++;
      // Per-metric counters: a present-but-null pack must NOT dilute the average. A
      // partial MQTT report (soc/soh absent) would otherwise deflate the headline because
      // the denominator counted it while the numerator didn't.
      if (pk.soc != null) { socSum += pk.soc; socN++; }
      const soh = pk.actSoh ?? pk.soh;
      if (soh != null) { sohSum += soh; sohN++; }
      if (pk.fullCapMah != null) fullMah += pk.fullCapMah;
      if (pk.designCapMah != null) designMah += pk.designCapMah;
      if (pk.balanceState != null && pk.balanceState !== 0) balancing += countSetBits(pk.balanceState);
      const t = pk.maxCellTemp ?? pk.temp;
      if (t != null && (!hottest || t > hottest.c)) hottest = { c: t, tag: `${d.deviceName} P${pk.num}` };
      if (pk.maxVolDiffMv != null && (!worstSpread || pk.maxVolDiffMv > worstSpread.mv))
        worstSpread = { mv: pk.maxVolDiffMv, tag: `${d.deviceName} P${pk.num}` };
    }
  }

  // Core membership: every SHP2-connected DPU vs the subset currently reporting fresh
  // per-pack telemetry. A connected core that's cloud-offline (e.g. a wired core whose
  // WiFi dropped) is still backing the home — its energy lives in the SHP2 aggregate, so
  // it must not silently vanish from the pool headline.
  const connectedDpus = dpus.filter((d) => isShp2Connected(d.sn, connectedSns));
  const reportingCores = connectedDpus.filter((d) => d.online && d.projection).length;
  const staleCores = connectedDpus.filter((d) => !(d.online && d.projection));

  // Capacity + pool SoC come from the SHP2's OWN aggregate (backupFullCapWh/backupBatPercent)
  // when present — it counts the whole wired pool including a cloud-stale core, so the
  // headline doesn't collapse ~33% the instant one core's WiFi drops. The per-pack sum is
  // only a no-SHP2 fallback (spare-only fleets). Degradation/hottest/spread/balancing stay
  // per-pack over the reporting cores (you can't read a stale core's live cell data anyway).
  const perPackCapKwh = (fullMah * MAH_TO_WH) / 1000;
  const poolCapKwh = shp2?.projection.backupFullCapWh != null ? shp2.projection.backupFullCapWh / 1000 : perPackCapKwh;
  const poolSocPct = shp2?.projection.backupBatPercent ?? (socN ? socSum / socN : null);
  const avgSoh = sohN ? sohSum / sohN : null;
  // Floored like the per-pack tile: summed fullCap can exceed summed design after a fleet
  // BMS recalibration, which would otherwise render an impossible "-x% degraded" at the pool.
  const degraded = designMah > 0 ? Math.max(0, (1 - fullMah / designMah) * 100) : null;
  const staleNote = staleCores.length
    ? `incl. ${staleCores.map((d) => d.deviceName).join(', ')} (wired, cloud-stale)`
    : undefined;

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Backup-pool battery summary</span>
        <span className="text-xs text-muted normal-case tracking-normal">
          {packs} packs · {reportingCores}/{connectedDpus.length} cores reporting
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile label="Avg SoC" value={poolSocPct != null ? fmtPct(poolSocPct, 0) : '—'} accent="text-accent" />
        <Tile label="Avg SoH" value={avgSoh != null ? fmtPct(avgSoh, 1) : '—'} accent={sohAccent(avgSoh)} />
        <Tile
          label="Capacity"
          value={`${poolCapKwh.toFixed(1)} kWh`}
          sub={[degraded != null ? `${degraded.toFixed(2)}% degraded` : null, staleNote].filter(Boolean).join(' · ') || undefined}
        />
        <Tile label="Hottest pack" value={fmtF(hottest?.c)} sub={hottest?.tag} accent={hottest && cToF(hottest.c) >= HOT_F ? 'text-warn' : undefined} />
        <Tile
          label="Worst cell spread"
          value={worstSpread ? `${worstSpread.mv} mV` : '—'}
          sub={worstSpread?.tag}
          accent={worstSpread && worstSpread.mv > 20 ? 'text-warn' : 'text-ok'}
        />
        <Tile label="Cells balancing" value={String(balancing)} accent={balancing > 0 ? 'text-accent' : 'text-muted'} />
      </div>
    </div>
  );
}

/* ---- Per-pack detail (flat — the wrapping .card is the panel) ---- */
function PackDetail({ pk }: { pk: DpuPack }) {
  const cellV = pk.cellVoltagesMv;
  const meanMv = cellV.length ? cellV.reduce((s, v) => s + v, 0) / cellV.length : null;
  const spreadMv = pk.maxVolDiffMv ?? (cellV.length ? Math.max(...cellV) - Math.min(...cellV) : null);
  const balancing = (pk.balanceState ?? 0) !== 0;
  const balancingCount = pk.balanceState ? countSetBits(pk.balanceState) : 0;

  return (
    <>
      {/* Live vitals */}
      <div>
        <SectionLabel>Vitals</SectionLabel>
        <ReadoutGrid>
          <Readout label="SoC" value={pk.soc != null ? `${Math.round(pk.soc)}%` : '—'} cls={socCellClass(pk.soc)} />
          <Readout label="Runtime" value={fmtMins(pk.remainTimeMin)} cls={BAND.info} />
          <Readout
            label="Input"
            value={fmtW(pk.inputWatts)}
            cls={pk.inputWatts != null && pk.inputWatts > 1 ? BAND.cool : BAND.info}
          />
          <Readout
            label="Output"
            value={fmtW(pk.outputWatts)}
            cls={pk.outputWatts != null && pk.outputWatts > 1 ? BAND.ok : BAND.info}
          />
          <Readout label="Rep temp" value={fmtF(pk.temp)} cls={tempClassFor('cell', pk.temp)} />
          <Readout label="Cell max" value={fmtF(pk.maxCellTemp)} cls={tempClassFor('cell', pk.maxCellTemp)} />
          <Readout label="Cell min" value={fmtF(pk.minCellTemp)} cls={tempClassFor('cell', pk.minCellTemp)} />
          <Readout label="Board" value={fmtF(pk.hwBoardTemp)} cls={tempClassFor('board', pk.hwBoardTemp)} />
          <Readout label="Shunt" value={fmtF(pk.curResTemp)} cls={tempClassFor('shunt', pk.curResTemp)} />
          <Readout label="MOS max" value={fmtF(pk.maxMosTemp)} cls={tempClassFor('mos', pk.maxMosTemp)} />
          <Readout label="Pack volt" value={fmtVolt(pk.packVoltageMv)} cls={BAND.info} />
          <Readout label="Open-circuit" value={fmtVolt(pk.ocvMv)} cls={BAND.info} />
          <Readout label="Cell mean" value={meanMv != null ? `${(meanMv / 1000).toFixed(3)} V` : '—'} cls={BAND.info} />
          <Readout
            label="Cell spread"
            value={spreadMv != null ? `${Math.round(spreadMv)} mV` : '—'}
            cls={spreadCellClass(spreadMv)}
          />
          <Readout
            label="Balancing"
            value={balancing ? `${balancingCount} cell${balancingCount === 1 ? '' : 's'}` : 'none'}
            cls={balancing ? BAND.cool : BAND.none}
          />
        </ReadoutGrid>
      </div>

      {/* Temperature sensors */}
      <div className="space-y-3">
        <div>
          <SectionLabel>Cell temperatures · {pk.cellTemps.length}</SectionLabel>
          <SensorGrid values={pk.cellTemps} prefix="C" kind="cell" />
        </div>
        <div>
          <SectionLabel>MOSFET temperatures · {pk.mosTemps.length}</SectionLabel>
          <SensorGrid values={pk.mosTemps} prefix="M" kind="mos" />
        </div>
        <div>
          <SectionLabel>PTC heater temperatures · {pk.ptcTemps.length}</SectionLabel>
          <SensorGrid values={pk.ptcTemps} prefix="P" kind="ptc" />
        </div>
      </div>

      {/* Cell voltages */}
      {cellV.length > 0 && meanMv != null && (
        <div>
          <SectionLabel>Cell voltages · {cellV.length} (deviation from mean)</SectionLabel>
          <CellVoltageGrid values={cellV} meanMv={meanMv} balanceState={pk.balanceState} />
        </div>
      )}

      <PackHealthRow pk={pk} />
    </>
  );
}

function PackHealthRow({ pk }: { pk: DpuPack }) {
  const sohValue = pk.actSoh ?? pk.soh;
  const fullWh = mahToWh(pk.fullCapMah);
  const designWh = mahToWh(pk.designCapMah);
  const remainWh = mahToWh(pk.remainCapMah);
  // Floor at 0: a freshly-calibrated pack can read full-cap slightly ABOVE nameplate
  // (actSoh > 100), which made this go negative ("-0.44% degraded") next to a "100%"
  // SoH tile — a self-contradiction. Capacity can still exceed design; degradation can't.
  const degradationPct =
    pk.designCapMah != null && pk.fullCapMah != null && pk.designCapMah > 0
      ? Math.max(0, (1 - pk.fullCapMah / pk.designCapMah) * 100)
      : null;
  const chgWh = mahToWh(pk.accuChgMah);
  const dsgWh = mahToWh(pk.accuDsgMah);
  const cyclesEquivFromChg =
    pk.accuChgMah != null && pk.fullCapMah != null && pk.fullCapMah > 0 ? pk.accuChgMah / pk.fullCapMah : null;

  return (
    <div className="pt-3 border-t border-line/60">
      <SectionLabel>Health</SectionLabel>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          label="State of health"
          value={sohValue != null ? fmtSoh(sohValue) : '—'}
          accent={sohAccent(sohValue)}
          sub={degradationPct != null ? `${degradationPct.toFixed(2)}% degraded` : undefined}
          small
        />
        <Tile
          label="Cycles"
          value={pk.cycles != null ? `${pk.cycles}` : '—'}
          sub={cyclesEquivFromChg != null ? `≈ ${cyclesEquivFromChg.toFixed(1)} full-cycles (charge throughput)` : undefined}
          small
        />
        <Tile
          label="Capacity"
          value={fullWh != null && designWh != null ? `${(fullWh / 1000).toFixed(2)} / ${(designWh / 1000).toFixed(2)} kWh` : '—'}
          sub={remainWh != null ? `now ${fmtWh(remainWh)}` : undefined}
          small
        />
        <Tile
          label="Lifetime throughput"
          value={chgWh != null && dsgWh != null ? `${(chgWh / 1000).toFixed(0)} / ${(dsgWh / 1000).toFixed(0)} kWh` : '—'}
          sub="charged · discharged"
          small
        />
      </div>
    </div>
  );
}

function sohAccent(soh: number | null | undefined): string {
  if (soh == null) return '';
  if (soh >= 95) return 'text-ok';
  if (soh >= 85) return 'text-amber-700';
  if (soh >= 75) return 'text-warn';
  return 'text-bad';
}

function CellVoltageGrid({
  values,
  meanMv,
  balanceState,
}: {
  values: number[];
  meanMv: number;
  balanceState: number | null;
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: GRID_COLS }}>
      {values.map((mv, i) => {
        const dev = mv - meanMv;
        const balancing = balanceState != null && balanceState !== 0 && ((balanceState >> i) & 1) === 1;
        return (
          <div
            key={i}
            className={`relative border rounded-md px-2 py-2 text-center ${cellDevColor(dev)} ${
              balancing ? 'ring-2 ring-accent' : ''
            }`}
            title={balancing ? 'Currently balancing' : ''}
          >
            <div className="text-xs uppercase tracking-wide leading-none opacity-70">C{i + 1}</div>
            <div className="text-base font-semibold font-mono tabular-nums leading-none mt-1.5">
              {(mv / 1000).toFixed(3)}
            </div>
            <div className="text-xs font-mono tabular-nums leading-none mt-1 opacity-70">
              {dev >= 0 ? '+' : ''}
              {dev.toFixed(0)} mV
            </div>
            {balancing && (
              <span className="absolute top-1 right-1.5 text-xs" title="balancing">↻</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function countSetBits(n: number): number {
  let c = 0;
  let x = n >>> 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

function SensorGrid({ values, prefix, kind }: { values: number[]; prefix: string; kind: 'cell' | 'mos' | 'ptc' }) {
  if (values.length === 0) return <div className="text-sm text-muted">no data</div>;
  return (
    <ReadoutGrid>
      {values.map((c, i) => (
        // PTC heaters run hot by design (they warm the pack), so there's no
        // good/bad threshold — show them neutral. Cells/MOSFETs use their own bands.
        <Readout key={i} label={`${prefix}${i + 1}`} value={fmtF(c)} cls={kind === 'ptc' ? BAND.info : tempClassFor(kind, c)} />
      ))}
    </ReadoutGrid>
  );
}

/* ---- Shared layout primitives ---- */
function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs uppercase tracking-widest text-muted font-semibold mb-1.5">{children}</div>;
}

function ReadoutGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: GRID_COLS }}>
      {children}
    </div>
  );
}

/** A single labelled readout — small uppercase label over a large value, on a status backplate. */
function Readout({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className={`border rounded-md px-2 py-2 text-center ${cls}`}>
      <div className="text-xs uppercase tracking-wide leading-none opacity-70">{label}</div>
      <div className="text-base font-semibold font-mono tabular-nums leading-none mt-1.5">{value}</div>
    </div>
  );
}

function Tile({ label, value, sub, accent, small }: { label: string; value: string; sub?: string; accent?: string; small?: boolean }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-md p-3">
      <div className="text-xs uppercase tracking-widest text-muted">{label}</div>
      <div className={`${small ? 'text-lg' : 'text-2xl'} font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}
