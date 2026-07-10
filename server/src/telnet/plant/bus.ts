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
  // v0.9.33 — data rows have a leading "<sp><state-glyph><sp>" (3 visible
  // chars) before the first column. The header used to use "  " (2 chars),
  // which shifted every header column one space LEFT of where the data
  // landed. The fix: 3-space header prefix to match the glyph's column.
  const headers = ['CH', 'NAME', 'BRK', 'V', 'P', 'A', 'LOAD%', 'STATE'];
  // Column-width budget: prefix(3) + CH + NAME(22) + BRK(5) + V(4) + P(10) +
  // A(6) + LOAD%-wrapper + STATE(6) + 7 join-spaces must total <= 80 — the
  // default negotiated NAWS terminal is 80x24, and index.ts's renderPlant()
  // does padEnd(body[i], W) with NO wrap, so anything past column 80 is
  // silently truncated off, including STATE (the per-circuit alarm/warn/
  // idle text). CH is 7 (not 6) so "10+12 ⇶" (7 visible chars — the only
  // double-digit+double-digit pair) keeps its split-phase glyph instead of
  // padEnd() truncating it away. The 8 columns that costs come back out of
  // LOAD%'s bar width below (gw), which is decorative — no numeric or name
  // data is shortened.
  out.push('   ' + c.grey([
    padEnd(headers[0], 7),
    padEnd(headers[1], 22),
    padStart(headers[2], 5),
    padStart(headers[3], 4),
    padStart(headers[4], 10),
    padStart(headers[5], 6),
    '  ' + padEnd(headers[6], 8),
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
    // gw shrunk 14->6 (and the LOAD%-wrapper below 16->8) to give back the
    // 8 columns CH/STATE need to both fit an 80-col frame — see the header
    // comment above for the full column-width budget. The bar is purely
    // decorative; the watts/amps/pct numbers next to it are untouched.
    const gw = 6;
    const gColor: 'green' | 'yellow' | 'red' =
      r.state === 'alarm' ? 'red' : r.state === 'warn' ? 'yellow' : 'green';
    const stateText =
      r.state === 'alarm' ? c.redB('ALARM') :
      r.state === 'warn' ? c.yellow('WARN') :
      watts < 1 ? c.grey('IDLE') : c.green('OK');

    out.push(' ' + stateGlyph(r.state) + ' ' + [
      // CH is 7 wide, not 6: "10+12 ⇶" is 7 visible chars, and padEnd()
      // truncates (never overflows) when content exceeds width — at 6 it
      // was silently dropping the ⇶ for every double-digit+double-digit
      // pair (only 10+12 today, but the next one is one paired-circuit
      // rename away).
      padEnd(c.whiteB(r.ch) + (r.isSplit ? c.grey(' ⇶') : ''), 7),
      padEnd(truncate(c.white(r.name), 22), 22),
      padStart(r.breaker != null ? `${r.breaker}A` : '—', 5),
      padStart(`${r.v}`, 4),
      padStart(fmtKw(watts), 10),
      padStart(amps != null ? `${amps.toFixed(1)}A` : '—', 6),
      '  ' + padEnd(gauge(pct, gw, gColor) + ` ${pct.toFixed(0).padStart(3)}%`, 8),
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
