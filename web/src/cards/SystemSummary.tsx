import type { DeviceSnapshot, DpuProjection, Shp2Projection } from '../types';
import { fmtMins, fmtPct, fmtW, fmtWh, socColor } from '../format';
import { shp2ConnectedDpuSns, isShp2Connected } from '../shp2Membership';

export function SystemSummary({ devices }: { devices: Record<string, DeviceSnapshot> }) {
  const list = Object.values(devices);
  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  // v0.9.75 — match the server-side filter applied in /api/ha-state and
  // MQTT Discovery: only DPUs wired into the SHP2 contribute to fleet
  // totals. The fleet PV / inverter-out / battery-net tiles previously
  // summed every DPU on the account and inflated the home's apparent
  // power flow by the spare cores' share. avg-SoC was the worst offender
  // — a spare core sitting at storage SoC (50 %) on the bench dragged
  // the home's true "available reserve" down by ~10 % when included.
  const connectedSns = shp2ConnectedDpuSns(devices);
  const onlineDpus = dpus.filter((d) => d.online && d.projection);
  const connectedOnline = onlineDpus.filter((d) => isShp2Connected(d.sn, connectedSns));
  const pvTotal = connectedOnline.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  const acOutTotal = connectedOnline.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
  const acInTotal = connectedOnline.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  const batWattsTotal = connectedOnline.reduce(
    (s, d) => s + ((d.projection.totalOutWatts ?? 0) - (d.projection.totalInWatts ?? 0)),
    0,
  );

  const avgSoc =
    connectedOnline.length === 0
      ? null
      : connectedOnline.reduce((s, d) => s + (d.projection.soc ?? 0), 0) / connectedOnline.length;

  const circuitLoad = shp2?.projection.circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? null;

  return (
    <div className="card col-span-full">
      <div className="card-title">
        <span>Energy flow</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Tile label="Solar (PV)" value={fmtW(pvTotal)} accent="text-warn" sub={`${connectedOnline.length} connected DPU${connectedOnline.length === 1 ? '' : 's'}`} />
        <Tile
          label="Batteries"
          value={fmtPct(avgSoc, 1)}
          sub={`${connectedOnline.length}/${onlineDpus.length} connected · ${connectedOnline.reduce((s, d) => s + d.projection.packs.length, 0)} packs`}
          accent="text-accent"
          progress={avgSoc ?? undefined}
        />
        <Tile label="Grid in" value={fmtW(acInTotal)} sub="off-grid if 0 W" accent="text-muted" />
        <Tile label="Inverter out" value={fmtW(acOutTotal)} accent="text-ok" sub="3-phase AC" />
        <Tile
          label="Battery net"
          value={fmtW(batWattsTotal)}
          sub={batWattsTotal > 0 ? 'discharging' : batWattsTotal < 0 ? 'charging' : 'idle'}
          accent={batWattsTotal > 0 ? 'text-bad' : batWattsTotal < 0 ? 'text-ok' : 'text-muted'}
        />
      </div>
      {shp2 && (
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label="SHP2 Backup" value={fmtPct(shp2.projection.backupBatPercent)} sub={`reserve ${fmtPct(shp2.projection.backupReserveSoc)}`} progress={shp2.projection.backupBatPercent ?? undefined} />
          <Tile label="Remain (disch)" value={fmtMins(shp2.projection.backupDischargeTimeMin)} sub={`@ current load`} accent="text-ok" />
          <Tile label="Charge time" value={fmtMins(shp2.projection.backupChargeTimeMin)} sub={`to full @ ${fmtW(shp2.projection.chargeWattPower)}`} accent="text-warn" />
          <Tile label="Panel load" value={fmtW(circuitLoad)} sub={`${shp2.projection.circuits.filter((c) => (c.watts ?? 0) > 1).length} active circuits`} accent="text-accent" />
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  accent,
  progress,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  progress?: number;
}) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent ?? ''}`}>{value}</div>
      {progress != null && (
        <div className="bar mt-2"><div className={socColor(progress)} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>
      )}
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
