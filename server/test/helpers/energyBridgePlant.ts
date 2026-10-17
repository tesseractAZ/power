/**
 * v1.188.1 — a simulated plant for the energy bridge, driven through the REAL recorder: three home
 * Cores on one Smart Home Panel 2, a store the recorder reads, and a second connection that writes
 * the samples the recorder would have recorded (the store emits no 'change', so nothing else does).
 *
 * Time moves a minute at a time (`run`), with a lifetime rollup every 5 minutes, each followed by a
 * published read asserted never to decrease. Each Core's online flag carries the transition time the
 * store stamps (`onlineChangedAtMs`): `setOnline` stamps it, `darkAtFirstSight` (a Core offline
 * since before the add-on saw it) and a restart do not. A Core that reports records its own
 * pv_total / ac_in each minute; its BMS registers move with `coreBatW` and freeze while it is
 * offline, then jump to the true count when it reports again. Test serials are placeholders.
 *
 * DB_PATH must name a fresh file before the recorder is imported: `loadPlant` sets it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

type Any = any;

export const MIN = 60_000;
export const H = 60 * MIN;
export const PANEL = 'HD31XXX00XXX0001';
export const CORES = ['Y711XXX00XXX0001', 'Y711XXX00XXX0002', 'Y711XXX00XXX0003'];
export const PACK_MAH_TO_WH = 0.1024;
export const FULL_CAP_MAH = 56_000; // per pack: 5,734 Wh
export const PACKS = 2;
/** The panel's nameplate per source (the capacity when no pack capacity is recorded). */
export const NAMEPLATE_WH = 30_720;
/** The 10-15 slot meters (W): the Cores supplying the panel. */
export const DISCHARGE_W = [-1145, -1145, -1119];

type Regs = { chg: number; dsg: number };
type Totals = { chg: number; dsg: number; pv: number; gridImport: number };

export const near = (a: number, b: number, tol: number, msg: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(1)} vs ${b.toFixed(1)} (±${tol})`);

export async function loadPlant(prefix: string) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const DB_PATH = join(tmp, 'ecoflow.db');
  process.env.DB_PATH = DB_PATH;
  // The v1.98.0 floor-gap re-seed at 5 kWh, so a few bridged hours already cross it.
  process.env.BMS_RESEED_MIN_GAP_WH = '5000';
  process.env.BMS_RESEED_SUSTAINED_ROLLUPS = '2';
  const { createRecorder } = await import('../../src/recorder.js');
  type Rec = ReturnType<typeof createRecorder>;
  const realNow = Date.now;

  function dpu(sn: string, online: boolean, regs: Regs | null, changedAt: number | undefined): Any {
    return {
      sn, deviceName: sn, productName: 'DELTA Pro Ultra', online, lastUpdated: 0,
      ...(changedAt != null ? { onlineChangedAtMs: changedAt } : {}),
      ...(regs ? {
        projection: {
          kind: 'dpu', soc: 60, packCount: PACKS, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, acOutWatts: 0,
          packs: Array.from({ length: PACKS }, (_, i) => ({
            num: i + 1, packSn: `${sn}-P${i + 1}`, soc: 60, inputWatts: 0, outputWatts: 0,
            designCapMah: 60_000, fullCapMah: FULL_CAP_MAH, remainCapMah: 30_000,
            accuChgMah: regs.chg, accuDsgMah: regs.dsg,
          })),
        },
      } : {}),
    };
  }

  function panelDev(t: number, p: Plant): Any {
    return {
      sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true,
      lastUpdated: t, lastQuotaAtMs: t, contentStaleSinceMs: null,
      projection: {
        kind: 'shp2', backupBatPercent: 60, backupFullCapWh: 92_160, backupRemainWh: 55_000, backupReserveSoc: 10,
        circuits: [{ ch: 1, watts: 3400, name: 'Main' }], pairedCircuits: [], gridWatt: 0, gridSta: 1, gridConnected: true,
        sourceWatts: p.sourceWatts,
        sources: CORES.map((sn, i) => ({
          slot: i + 1, sn, isConnected: p.connected[i], isAcOpen: true, batteryPercentage: p.pct[i], fullCap: NAMEPLATE_WH,
          ratePower: null, emsBatTemp: null, hwConnect: true, errorCodeNum: null, forceCharge: null,
          pvWatts: p.pvW[i], pvHighWatts: null, pvLowWatts: null, inputWatts: 0, outputWatts: 0,
        })),
        strategy: {},
      },
    };
  }

  class Plant {
    clock: number;
    rec!: Rec;
    store: Any;
    db!: DatabaseSync;
    ins!: ReturnType<DatabaseSync['prepare']>;
    logs: string[] = [];
    last: Record<string, number> = {};
    sourceWatts = [0, 0, 0];
    pct = [60, 60, 60];
    pvW = [0, 0, 0];
    connected = [true, true, true];
    /** Each Core's own MPPT and AC-input power, W: recorded each minute while it reports. */
    corePv = [0, 0, 0];
    coreAcIn = [0, 0, 0];
    /** DC battery power per Core, W (positive = discharging): moves its true registers each minute. */
    coreBatW: number[] | null = null;
    online: Record<string, boolean> = Object.fromEntries(CORES.map((sn) => [sn, true]));
    changedAt: Record<string, number | undefined> = {};
    /** The registers every Core shows (tests that move all Cores together set this). */
    regs: Regs | null = { chg: 1_000_000, dsg: 1_000_000 };
    /** Per-Core TRUE registers once `coreBatW` moves them; `shown` is what each Core reports. */
    trueRegs: Record<string, Regs> = {};
    shown: Record<string, Regs> = {};
    /** Keep the dark Cores' projection (the store preserves it across an offline flip); false = a
     *  restart while dark (no projection at all). */
    frozenProjection = true;
    panelStale = false;

    constructor(t0: number, opts: { reuse?: boolean } = {}) {
      if (!opts.reuse) for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
      this.clock = t0;
      Date.now = () => this.clock;
      const ee = new EventEmitter() as Any;
      ee.get = () => ({ generatedAt: this.clock, devices: this.devices() });
      this.store = ee;
      this.open();
    }
    get coresOnline(): boolean { return CORES.every((sn) => this.online[sn]); }
    set coresOnline(v: boolean) { this.setOnline(v); }
    /** Flip Cores online/offline at `at` (the store's onlineChangedAtMs). */
    setOnline(v: boolean, sns: string[] = CORES, at: number = this.clock): void {
      for (const sn of sns) {
        if (this.online[sn] === v) continue;
        this.online[sn] = v;
        this.changedAt[sn] = at;
        if (v && this.trueRegs[sn]) this.shown[sn] = { ...this.trueRegs[sn] }; // the jump lands
      }
    }
    /** Offline since before the add-on saw them: the device list's first sight carries no transition. */
    darkAtFirstSight(): void {
      for (const sn of CORES) { this.online[sn] = false; this.changedAt[sn] = undefined; }
    }
    open(): void {
      this.rec = createRecorder(this.store, (m) => this.logs.push(m));
      this.db = new DatabaseSync(DB_PATH);
      this.ins = this.db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    }
    /** A restart: the store sees every Core afresh (no transition times). */
    restart(): void {
      this.rec.close();
      this.db.close();
      for (const sn of CORES) this.changedAt[sn] = undefined;
      this.open();
    }
    close(): void {
      this.rec.close();
      this.db.close();
      Date.now = realNow;
    }
    regsOf(sn: string): Regs | null {
      return this.shown[sn] ?? this.regs;
    }
    devices(): Record<string, Any> {
      const out: Record<string, Any> = { [PANEL]: panelDev(this.panelStale ? this.clock - 600_000 : this.clock, this) };
      for (const sn of CORES) {
        const projected = this.online[sn] || this.frozenProjection;
        out[sn] = dpu(sn, this.online[sn], projected ? this.regsOf(sn) : null, this.changedAt[sn]);
      }
      return out;
    }
    sample(sn: string, metric: string, value: number, ts = this.clock): void {
      this.ins.run(ts, sn, metric, value);
    }
    /** Record the panel's slot series at `t` (what extract() writes). */
    panelSamples(t: number): void {
      for (let i = 0; i < 3; i++) {
        this.sample(PANEL, `src${i + 1}_w`, this.sourceWatts[i], t);
        this.sample(PANEL, `src${i + 1}_pct`, this.pct[i], t);
        this.sample(PANEL, `src${i + 1}_pv_w`, this.pvW[i], t);
      }
      this.sample(PANEL, 'grid_home_w', 0, t);
    }
    /** One minute of the plant: the panel's series, each reporting Core's own series, the registers. */
    minute(t: number): void {
      this.panelSamples(t);
      CORES.forEach((sn, i) => {
        if (this.coreBatW) {
          const tr = this.trueRegs[sn] ?? { ...(this.regs ?? { chg: 0, dsg: 0 }) };
          const mah = Math.abs(this.coreBatW[i]) / 60 / PACK_MAH_TO_WH / PACKS;
          if (this.coreBatW[i] > 0) tr.dsg += mah; else tr.chg += mah;
          this.trueRegs[sn] = tr;
          if (this.online[sn]) this.shown[sn] = { ...tr };
          else this.shown[sn] ??= { ...(this.regs ?? tr) };
        }
        if (!this.online[sn]) return;
        this.sample(sn, 'pv_total', this.corePv[i], t);
        this.sample(sn, 'ac_in', this.coreAcIn[i], t);
      });
    }
    /** Advance the clock minute by minute; a lifetime rollup every 5 minutes, each followed by a
     *  published read (asserted never to decrease); `readEach` reads every minute as well. */
    run(minutes: number, each: (t: number, m: number) => void = () => {}, opts: { readEach?: boolean } = {}): void {
      for (let m = 1; m <= minutes; m++) {
        const t = this.clock + MIN;
        each(t, m);
        this.minute(t);
        this.clock = t;
        if (m % 5 === 0) {
          this.rec.rollupLifetime();
          this.read();
        } else if (opts.readEach) {
          this.read();
        }
      }
    }
    totals(): Totals {
      const t = this.rec.getLifetimeTotals();
      const v = (k: string) => (t[k] ? t[k].persistedWh + t[k].pendingWh : 0);
      return { chg: v('fleet_battery_charge_wh'), dsg: v('fleet_battery_discharge_wh'), pv: v('fleet_pv_wh'), gridImport: v('fleet_grid_import_wh') };
    }
    /** A published read: every emitted total in `keys` is non-decreasing. */
    read(keys: ReadonlyArray<keyof Totals> = ['chg', 'dsg', 'pv', 'gridImport']): Totals {
      const t = this.totals();
      for (const k of keys) {
        const v = t[k];
        const prev = this.last[k];
        if (prev != null) assert.ok(v >= prev - 1e-6, `${k} stepped DOWN ${prev.toFixed(1)} → ${v.toFixed(1)} Wh at ${new Date(this.clock).toISOString()}`);
        this.last[k] = v;
      }
      return t;
    }
    /** The Cores report, capture baselines, then move a little: a held value exists per pack. */
    establishHeld(): void {
      this.rec.rollupLifetime();
      this.regs = { chg: 1_010_000, dsg: 1_008_000 };
      this.run(5);
    }
    goDark(sourceWatts: number[]): void {
      this.coresOnline = false;
      this.sourceWatts = sourceWatts;
    }
    rows(): string {
      return JSON.stringify(this.db.prepare('SELECT metric_key, wh, last_integrated_ts FROM lifetime_totals ORDER BY metric_key').all());
    }
    lifetimeKeys(): string[] {
      return (this.db.prepare('SELECT metric_key FROM lifetime_totals ORDER BY metric_key').all() as Array<{ metric_key: string }>).map((r) => r.metric_key);
    }
    /** Write a lifetime row directly (a state a previous process left). */
    putLifetime(key: string, wh: number, ts = this.clock): void {
      this.db.prepare('INSERT OR REPLACE INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)').run(key, wh, ts);
    }
  }

  const cleanup = (): void => {
    Date.now = realNow;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  };
  return { Plant, cleanup };
}
