/**
 * BUS screen — SHP2 main panel feeders.
 *
 * One row per circuit: name, breaker, instantaneous watts, breaker-load %,
 * state. Paired (split-phase) circuits are folded into single rows that
 * show the combined load, like a real panel meter would.
 */

import { c, padEnd, padStart, truncate, BOX } from '../ansi.js';
import { divider, gauge, stateGlyph } from './scada.js';
import { getShp2, circuitLoadState, deviceQuality, fmtW, fmtAmp } from './data.js';
import type { PlantData, PlantView } from './types.js';
import type { AlarmState } from './scada.js';

export function renderBus(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];
  const shp2 = getShp2(data);
  if (!shp2) {
    out.push(c.grey('  No SHP2 detected.'));
    return out;
  }
  const p = shp2.projection;
  const qual = deviceQuality(shp2);

  /* ── bus header ───────────────────────────────────────────────── */
  out.push(divider(`MAIN BUS — SHP2 ${shp2.sn}  ·  ${shp2.deviceName}`, W));
  const totalLoad = p.circuits.reduce((s, ch) => s + (ch.watts ?? 0), 0);
  const reserveSoc = p.backupReserveSoc ?? 0;
  const poolSoc = p.backupBatPercent ?? 0;
  out.push(padEnd(
    '  ' + c.grey('TOTAL LOAD ') + c.whiteB(fmtKw(totalLoad)) +
    c.grey('   POOL SOC ') + c.whiteB(`${poolSoc.toFixed(1)}%`) +
    c.grey('   RESERVE ') + c.cyan(`▲ ${reserveSoc}%`) +
    c.grey('   CHG PWR LIMIT ') + c.white(fmtKw(p.chargeWattPower ?? 0)),
    W,
  ));
  out.push('');

  /* ── feeders table — paired-aware ─────────────────────────────── */
  out.push(divider('FEEDERS — paired circuits aggregated', W));
  const headers = ['CH', 'NAME', 'BRK', 'V', 'P', 'A', 'LOAD%', 'STATE'];
  out.push('  ' + c.grey([
    padEnd(headers[0], 6),
    padEnd(headers[1], 22),
    padStart(headers[2], 5),
    padStart(headers[3], 4),
    padStart(headers[4], 10),
    padStart(headers[5], 6),
    '  ' + padEnd(headers[6], 16),
    padEnd(headers[7], 6),
  ].join(' ')));

  // Build the paired-circuit row set: paired first, then unpaired-circuit fallback.
  const pairedChs = new Set<number>();
  for (const pc of p.pairedCircuits) {
    pairedChs.add(pc.primaryCh);
    if (pc.secondaryCh != null) pairedChs.add(pc.secondaryCh);
  }
  type Row = { ch: string; name: string; breaker: number | null; v: number; w: number | null; state: AlarmState; isSplit: boolean };
  const rows: Row[] = [];
  for (const pc of p.pairedCircuits) {
    rows.push({
      ch: pc.secondaryCh != null ? `${pc.primaryCh}+${pc.secondaryCh}` : String(pc.primaryCh),
      name: pc.name || `circuit ${pc.primaryCh}`,
      breaker: pc.breakerAmps,
      v: pc.isSplitPhase ? 240 : 120,
      w: pc.watts,
      state: circuitLoadState(pc.watts, pc.breakerAmps, pc.isSplitPhase ? 240 : 120),
      isSplit: pc.isSplitPhase,
    });
  }
  for (const ch of p.circuits) {
    if (pairedChs.has(ch.ch)) continue;
    rows.push({
      ch: String(ch.ch),
      name: ch.name || `circuit ${ch.ch}`,
      breaker: ch.setAmp,
      v: 120,
      w: ch.watts,
      state: circuitLoadState(ch.watts, ch.setAmp, 120),
      isSplit: false,
    });
  }
  // Sort by sortable channel number (primary).
  rows.sort((a, b) => Number(a.ch.split('+')[0]) - Number(b.ch.split('+')[0]));

  for (const r of rows) {
    const watts = r.w ?? 0;
    const amps = r.breaker ? watts / r.v : null;
    const pct = r.breaker ? Math.min(100, (Math.abs(watts) / (r.breaker * r.v)) * 100) : 0;
    const gw = 14;
    const gColor: 'green' | 'yellow' | 'red' =
      r.state === 'alarm' ? 'red' : r.state === 'warn' ? 'yellow' : 'green';
    const stateText =
      r.state === 'alarm' ? c.redB('ALARM') :
      r.state === 'warn' ? c.yellow('WARN') :
      watts < 1 ? c.grey('IDLE') : c.green('OK');

    out.push(' ' + stateGlyph(r.state) + ' ' + [
      padEnd(c.whiteB(r.ch) + (r.isSplit ? c.grey(' ⇶') : ''), 6),
      padEnd(truncate(c.white(r.name), 22), 22),
      padStart(r.breaker != null ? `${r.breaker}A` : '—', 5),
      padStart(`${r.v}`, 4),
      padStart(fmtKw(watts), 10),
      padStart(amps != null ? `${amps.toFixed(1)}A` : '—', 6),
      '  ' + padEnd(gauge(pct, gw, gColor) + ` ${pct.toFixed(0).padStart(3)}%`, 16),
      padEnd(stateText, 6),
    ].join(' '));
  }

  out.push('');
  out.push(c.grey('  ⇶ = split-phase pair (combined watts shown)'));
  out.push('');

  /* ── source slots — backup pool members ───────────────────────── */
  out.push(divider('BACKUP-POOL SOURCES', W));
  for (const s of p.sources) {
    const stateName =
      !s.isConnected ? c.grey('DISCONNECTED') :
      !s.isAcOpen ? c.cyan('CONNECTED · STBY') :
      c.green('ACTIVE');
    out.push(padEnd(
      '  ' + c.grey('SLOT ') + c.whiteB(String(s.slot)) +
      c.grey('  SN ') + c.white(s.sn ?? '—') +
      c.grey('  SOC ') + c.whiteB(`${(s.batteryPercentage ?? 0).toFixed(0)}%`) +
      c.grey('  CAP ') + c.white(`${((s.fullCap ?? 0) / 1000).toFixed(2)} kWh`) +
      c.grey('  TEMP ') + c.white(s.emsBatTemp != null ? `${(((s.emsBatTemp ?? 0) * 9) / 5 + 32).toFixed(0)}°F` : '—') +
      '  ' + stateName,
      W,
    ));
  }

  return out;
}

function fmtKw(w: number): string {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}
