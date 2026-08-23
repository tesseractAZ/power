/**
 * warrantyExport.ts — v1.90.0 (register B3). One-command evidence bundle for a
 * warranty claim: everything the RMA thread needs, from live telemetry plus
 * the persisted alert history, as a paste-ready markdown document (or CSV of
 * the per-cell grid).
 *
 * Built for the Core 3 pack-1 case (err533 since 2026-07-20; spread 71→98→122
 * mV; pack pinned at 1-2% with siblings 10-60 points higher) but generic over
 * any DPU serial. READ-ONLY: live projection + `/data/cleared-alerts.json`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

export interface WarrantyPackRow {
  pack: number;
  packSn: string | null;
  socPct: number | null;
  sohPct: number | null;
  packVoltageMv: number | null;
  spreadMv: number | null;
  minCellMv: number | null;
  maxCellMv: number | null;
  cycles: number | null;
  remainCapMah: number | null;
  tempC: number | null;
  cellVoltagesMv: number[] | null;
}

export interface WarrantyBundle {
  generatedAtIso: string;
  sn: string;
  deviceName: string;
  sysErrCode: number | null;
  deviceSocPct: number | null;
  emsWindowMv: { min: number | null; max: number | null };
  packs: WarrantyPackRow[];
  /** Persisted alert history rows for this SN (newest first). */
  history: Array<{ raisedAtIso: string; clearedAtIso: string; durationMin: number; severity: string; title: string; fault?: string }>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: build the bundle from a device row + the cleared-alert records. */
export function buildWarrantyBundle(
  device: { sn: string; deviceName?: string; projection?: any },
  clearedRecords: Array<{ alert?: { id?: string; severity?: string; title?: string; fault?: string; sourceSn?: string; sourcePackSn?: string }; raisedAt?: number; clearedAt?: number; durationMs?: number }>,
  nowIso: string,
  /** v1.102.0 — narrow the history to ONE pack serial, wherever it has lived. */
  focusPackSn?: string,
): WarrantyBundle {
  const p = device.projection ?? {};
  const packs: WarrantyPackRow[] = (Array.isArray(p.packs) ? p.packs : []).map((pk: any, i: number) => {
    const cells: number[] | null = Array.isArray(pk.cellVoltagesMv) ? pk.cellVoltagesMv.filter((c: unknown) => typeof c === 'number') : null;
    const min = cells && cells.length ? Math.min(...cells) : num(pk.minCellVoltageMv);
    const max = cells && cells.length ? Math.max(...cells) : num(pk.maxCellVoltageMv);
    return {
      pack: num(pk.num) ?? i + 1,
      packSn: typeof pk.packSn === 'string' ? pk.packSn : null,
      socPct: num(pk.soc),
      sohPct: num(pk.actSoh) ?? num(pk.soh),
      packVoltageMv: num(pk.adBatVoltageMv) ?? num(pk.packVoltageMv),
      spreadMv: min != null && max != null ? max - min : num(pk.maxVolDiffMv),
      minCellMv: min, maxCellMv: max,
      cycles: num(pk.cycles),
      remainCapMah: num(pk.remainCapMah) ?? num(pk.remainCap),
      tempC: num(pk.temp) ?? num(pk.maxCellTemp),
      cellVoltagesMv: cells,
    };
  });
  // v1.102.0 — follow the PACK, not just the chassis.
  //
  // History was admitted by chassis serial alone, so a pack that moves between
  // chassis has its record split at the swap: the receiving chassis shows a
  // near-empty history while the month of evidence stays filed under the old
  // one. For an RMA that is the wrong way round — the claim is about the pack.
  // Records now also match on the pack serials this device currently holds, and
  // a `?packSn=` query narrows the bundle to ONE pack's history wherever it has
  // lived.
  const heldPackSns = new Set(packs.map((p) => p.packSn).filter((x): x is string => !!x));
  const wantPackSn = focusPackSn ?? null;
  const history = clearedRecords
    .filter((r) => {
      const id = r.alert?.id ?? '';
      const recPack = r.alert?.sourcePackSn;
      if (wantPackSn != null) return recPack === wantPackSn;
      if (recPack != null && heldPackSns.has(recPack)) return true;
      return id.includes(device.sn) || r.alert?.sourceSn === device.sn;
    })
    .sort((a, b) => (b.clearedAt ?? 0) - (a.clearedAt ?? 0))
    .slice(0, 200)
    .map((r) => ({
      raisedAtIso: r.raisedAt ? new Date(r.raisedAt).toISOString() : '?',
      clearedAtIso: r.clearedAt ? new Date(r.clearedAt).toISOString() : '?',
      durationMin: Math.round((r.durationMs ?? 0) / 60_000),
      severity: r.alert?.severity ?? '?',
      title: r.alert?.title ?? '?',
      ...(r.alert?.fault ? { fault: r.alert.fault } : {}),
    }));
  return {
    generatedAtIso: nowIso,
    sn: device.sn,
    deviceName: device.deviceName ?? device.sn,
    sysErrCode: num(p.errCode) ?? num(p.sysErrCode),
    deviceSocPct: num(p.soc),
    emsWindowMv: { min: num(p.emsParaVolMinMv), max: num(p.emsParaVolMaxMv) },
    packs, history,
  };
}

/** Pure: render the bundle as a paste-ready markdown document. */
export function renderWarrantyMarkdown(b: WarrantyBundle): string {
  const L: string[] = [];
  L.push(`# Warranty evidence bundle — ${b.deviceName} (${b.sn})`);
  L.push('');
  L.push(`Generated ${b.generatedAtIso} by the ecoflow-panel monitor (continuous local telemetry).`);
  L.push('');
  L.push(`- Device error code: **${b.sysErrCode ?? 'none'}**`);
  L.push(`- Device SoC at capture: ${b.deviceSocPct ?? '?'}%`);
  L.push(`- EMS parallel-voltage window: ${b.emsWindowMv.min ?? '?'}–${b.emsWindowMv.max ?? '?'} mV`);
  L.push('');
  L.push('## Per-pack summary');
  L.push('');
  L.push('| Pack | Pack SN | SoC % | SoH % | Pack mV | Spread mV | Min cell mV | Max cell mV | Cycles | Remain mAh | Temp °C |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of b.packs) {
    L.push(`| ${p.pack} | ${p.packSn ?? '?'} | ${p.socPct ?? '?'} | ${p.sohPct ?? '?'} | ${p.packVoltageMv ?? '?'} | ${p.spreadMv ?? '?'} | ${p.minCellMv ?? '?'} | ${p.maxCellMv ?? '?'} | ${p.cycles ?? '?'} | ${p.remainCapMah ?? '?'} | ${p.tempC ?? '?'} |`);
  }
  L.push('');
  L.push('## Per-cell voltages (mV)');
  L.push('');
  for (const p of b.packs) {
    if (!p.cellVoltagesMv || p.cellVoltagesMv.length === 0) continue;
    L.push(`### Pack ${p.pack}${p.packSn ? ` (${p.packSn})` : ''}`);
    L.push('');
    const cells = p.cellVoltagesMv;
    for (let row = 0; row < cells.length; row += 8) {
      const seg = cells.slice(row, row + 8);
      L.push(`- cells ${row + 1}–${row + seg.length}: ${seg.join(', ')}`);
    }
    L.push('');
  }
  L.push('## Alert history for this device (persisted record, newest first)');
  L.push('');
  if (b.history.length === 0) {
    L.push('(no persisted alert-history rows for this serial)');
  } else {
    L.push('| Raised (UTC) | Cleared (UTC) | Duration | Severity | Title | Fault |');
    L.push('|---|---|---|---|---|---|');
    for (const h of b.history) {
      L.push(`| ${h.raisedAtIso} | ${h.clearedAtIso} | ${h.durationMin} min | ${h.severity} | ${h.title} | ${h.fault ?? ''} |`);
    }
  }
  L.push('');
  return L.join('\n');
}

/** Pure: the per-cell grid as CSV (one row per cell, all packs). */
export function renderWarrantyCsv(b: WarrantyBundle): string {
  const rows = ['pack,pack_sn,cell,voltage_mv'];
  for (const p of b.packs) {
    if (!p.cellVoltagesMv) continue;
    p.cellVoltagesMv.forEach((mv, i) => rows.push(`${p.pack},${p.packSn ?? ''},${i + 1},${mv}`));
  }
  return rows.join('\n') + '\n';
}

/** Load the persisted cleared-alert records (same file alertMonitor persists). */
export function loadClearedRecords(): Array<Record<string, any>> {
  try {
    const path = process.env.CLEARED_LOG_PATH
      ?? resolve(process.cwd(), config.dbPath, '..', 'cleared-alerts.json');
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
