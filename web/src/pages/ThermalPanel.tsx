import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DeviceSnapshot, DpuPack, DpuProjection, Shp2Projection } from '../types';
import { cToF, fmtPct, fmtW, fmtWh, fmtMins } from '../format';
import { sortDevices } from '../sort';

// DPU pack capacity is reported in single-string mAh. Each pack is 16S2P at
// 51.2 V nominal, so Wh = mAh × 51.2 V × 2 strings / 1000.
const MAH_TO_WH = (51.2 * 2) / 1000;
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
    fmt: (v) => `${v.toFixed(1)}%`,
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
      <SummaryStrip dpus={dpus} />

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
                  className="flex items-center justify-center gap-1.5 min-w-0 text-xs uppercase tracking-widest text-muted"
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${d.online ? 'bg-ok' : 'bg-bad'}`} />
                  <span className="truncate" title={d.deviceName}>{d.deviceName}</span>
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
                    cls={tempCellClass(selDpu.projection.mpptHvTemp)}
                  />
                  <Readout
                    label="MPPT LV"
                    value={fmtF(selDpu.projection.mpptLvTemp)}
                    cls={tempCellClass(selDpu.projection.mpptLvTemp)}
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
                <div key={s.slot} className={`border rounded-md p-3 ${tempCellClass(s.emsBatTemp)}`}>
                  <div className="text-xs uppercase tracking-widest opacity-70">Slot {s.slot}</div>
                  <div className="text-sm font-medium truncate">{dpu?.deviceName ?? s.sn ?? '—'}</div>
                  <div className="text-2xl font-semibold tabular-nums mt-1">{fmtF(s.emsBatTemp)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Condensed fleet summary strip ---- */
function SummaryStrip({ dpus }: { dpus: Array<DeviceSnapshot & { projection?: DpuProjection }> }) {
  let packs = 0;
  let socSum = 0;
  let sohSum = 0;
  let fullMah = 0;
  let designMah = 0;
  let balancing = 0;
  let hottest: { c: number; tag: string } | null = null;
  let worstSpread: { mv: number; tag: string } | null = null;
  for (const d of dpus) {
    if (!d.online || !d.projection) continue;
    for (const pk of d.projection.packs) {
      packs++;
      if (pk.soc != null) socSum += pk.soc;
      const soh = pk.actSoh ?? pk.soh;
      if (soh != null) sohSum += soh;
      if (pk.fullCapMah != null) fullMah += pk.fullCapMah;
      if (pk.designCapMah != null) designMah += pk.designCapMah;
      if (pk.balanceState != null && pk.balanceState !== 0) balancing += countSetBits(pk.balanceState);
      const t = pk.maxCellTemp ?? pk.temp;
      if (t != null && (!hottest || t > hottest.c)) hottest = { c: t, tag: `${d.deviceName} P${pk.num}` };
      if (pk.maxVolDiffMv != null && (!worstSpread || pk.maxVolDiffMv > worstSpread.mv))
        worstSpread = { mv: pk.maxVolDiffMv, tag: `${d.deviceName} P${pk.num}` };
    }
  }
  const capNowKwh = (fullMah * MAH_TO_WH) / 1000;
  const degraded = designMah > 0 ? (1 - fullMah / designMah) * 100 : null;

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Fleet battery summary</span>
        <span className="text-xs text-muted normal-case tracking-normal">{packs} packs live</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile label="Avg SoC" value={packs ? fmtPct(socSum / packs, 0) : '—'} accent="text-accent" />
        <Tile label="Avg SoH" value={packs ? fmtPct(sohSum / packs, 1) : '—'} accent={sohAccent(packs ? sohSum / packs : null)} />
        <Tile label="Capacity" value={`${capNowKwh.toFixed(1)} kWh`} sub={degraded != null ? `${degraded.toFixed(2)}% degraded` : undefined} />
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
          <Readout label="Rep temp" value={fmtF(pk.temp)} cls={tempCellClass(pk.temp)} />
          <Readout label="Cell max" value={fmtF(pk.maxCellTemp)} cls={tempCellClass(pk.maxCellTemp)} />
          <Readout label="Cell min" value={fmtF(pk.minCellTemp)} cls={tempCellClass(pk.minCellTemp)} />
          <Readout label="Board" value={fmtF(pk.hwBoardTemp)} cls={tempCellClass(pk.hwBoardTemp)} />
          <Readout label="Shunt" value={fmtF(pk.curResTemp)} cls={tempCellClass(pk.curResTemp)} />
          <Readout label="MOS max" value={fmtF(pk.maxMosTemp)} cls={tempCellClass(pk.maxMosTemp)} />
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
          <SensorGrid values={pk.cellTemps} prefix="C" />
        </div>
        <div>
          <SectionLabel>MOSFET temperatures · {pk.mosTemps.length}</SectionLabel>
          <SensorGrid values={pk.mosTemps} prefix="M" />
        </div>
        <div>
          <SectionLabel>PTC heater temperatures · {pk.ptcTemps.length}</SectionLabel>
          <SensorGrid values={pk.ptcTemps} prefix="P" />
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
  const degradationPct =
    pk.designCapMah != null && pk.fullCapMah != null && pk.designCapMah > 0
      ? (1 - pk.fullCapMah / pk.designCapMah) * 100
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
          value={sohValue != null ? `${sohValue.toFixed(sohValue >= 100 ? 0 : 2)}%` : '—'}
          accent={sohAccent(sohValue)}
          sub={degradationPct != null ? `${degradationPct.toFixed(2)}% degraded` : undefined}
          small
        />
        <Tile
          label="Cycles"
          value={pk.cycles != null ? `${pk.cycles}` : '—'}
          sub={cyclesEquivFromChg != null ? `≈ ${cyclesEquivFromChg.toFixed(1)} equiv` : undefined}
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

function SensorGrid({ values, prefix }: { values: number[]; prefix: string }) {
  if (values.length === 0) return <div className="text-sm text-muted">no data</div>;
  return (
    <ReadoutGrid>
      {values.map((c, i) => (
        <Readout key={i} label={`${prefix}${i + 1}`} value={fmtF(c)} cls={tempCellClass(c)} />
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
