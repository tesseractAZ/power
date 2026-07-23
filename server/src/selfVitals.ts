import { readFileSync, statfsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/* ═══════════════════════════════════════════════════════════════════════════
 * selfVitals.ts — in-band host-pressure vitals for the alarm process (v1.43.0).
 *
 * The add-on shares its host with co-tenant add-ons it does not control. A
 * neighbour leaking memory, spinning a CPU, or filling the shared disk
 * degrades THIS process long before anything crashes outright — and the alarm
 * cannot schedule the host. What it can do is notice the pressure while it
 * can still speak: event-loop lag is a direct measurement of how starved this
 * process is, and /proc + statfs show which host resource is being consumed.
 * At 'crit' the host tick sheds the add-on's own discretionary work
 * (degradedMode()) to protect the poll→alert→broadcast path.
 *
 * Design:
 *  - One 500 ms unref()'d interval measures event-loop lag (EMA α=0.2 plus a
 *    ~60 s windowed max); /proc/loadavg, /proc/meminfo and statfs(dataDir)
 *    are read inside tickAssess() on the host's 60 s cadence — no extra
 *    timers, no background I/O.
 *  - Null-honest: each external dimension reads null on any error (non-Linux
 *    host, masked /proc, unusual container runtime) and a null dimension can
 *    NEVER raise or hold an alert — null over fabrication. Event-loop lag is
 *    in-process and therefore always available; it is the backstop dimension.
 *  - assessVitals() is pure rise/clear hysteresis: escalation is immediate,
 *    de-escalation requires clearing the threshold by a margin and steps down
 *    one band per assessment — a reading oscillating on the line cannot
 *    churn, and a genuine recovery is confirmed before the level drops.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Thresholds with env overrides (clamped; out-of-range values fall back to
 *  the default). Lag/load fire at ≥ threshold; mem/disk fire below it.
 *  Load defaults assume the 4-core Pi host. */
const num = (name: string, dflt: number, lo: number, hi: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
};
export const VITALS_LAG_WARN_MS = num('VITALS_LAG_WARN_MS', 200, 20, 10_000);
export const VITALS_LAG_CRIT_MS = num('VITALS_LAG_CRIT_MS', 1000, 50, 60_000);
export const VITALS_MEM_WARN_MB = num('VITALS_MEM_WARN_MB', 700, 50, 16_384);
export const VITALS_MEM_CRIT_MB = num('VITALS_MEM_CRIT_MB', 350, 20, 8_192);
export const VITALS_DISK_WARN_MB = num('VITALS_DISK_WARN_MB', 2048, 128, 262_144);
export const VITALS_DISK_CRIT_MB = num('VITALS_DISK_CRIT_MB', 512, 32, 65_536);
export const VITALS_LOAD_WARN = num('VITALS_LOAD_WARN', 3.5, 0.5, 64);
export const VITALS_LOAD_CRIT = num('VITALS_LOAD_CRIT', 6, 1, 128);

/** De-escalation margins: lag clears below 0.8× threshold, mem/disk clear
 *  above 1.15× threshold, load clears below threshold − 0.5. */
export const VITALS_LAG_CLEAR_FRAC = 0.8;
export const VITALS_MEMDISK_CLEAR_FRAC = 1.15;
export const VITALS_LOAD_CLEAR_DELTA = 0.5;

/** Freshness bound, shared by two guards: a stored sample older than this
 *  reads null from liveVitals(), and a lag probe silent for longer than this
 *  means the probe is dead — tickAssess() then refuses to assess at all
 *  rather than dress a stale accumulator up as a fresh reading. */
export const VITALS_MAX_AGE_MS = 5 * 60 * 1000;

export const LAG_PROBE_INTERVAL_MS = 500;
export const LAG_EMA_ALPHA = 0.2;
const LAG_RING_SLOTS = 120; // 120 slots × 500 ms cadence ≈ the 60 s window
const LAG_WINDOW_MS = 60_000;

export interface VitalsSample {
  evLoopLagMs: number;        // EMA of event-loop lag (α=0.2), ms
  evLoopLagMaxMs: number;     // max single-probe lag in the last ~60s window
  load1: number | null;       // /proc/loadavg fields; null when unreadable
  load5: number | null;
  memAvailableMb: number | null;   // /proc/meminfo MemAvailable, MB
  dataDiskFreeMb: number | null;   // statfs free MB on the data dir
  ts: number;
}
export type VitalsLevel = 'ok' | 'warn' | 'crit';
export interface VitalsAssessment {
  level: VitalsLevel;              // max of the four dimension levels
  reasons: string[];               // human strings for each non-ok dimension, with values
  lag: VitalsLevel; mem: VitalsLevel; disk: VitalsLevel; load: VitalsLevel;
}

/* ── event-loop lag accumulator ──────────────────────────────────────────── */

const lagRing = new Float64Array(LAG_RING_SLOTS);
const lagRingTs = new Float64Array(LAG_RING_SLOTS);
let lagIdx = 0;
let lagCount = 0;
let lagEma = 0;
let lastLagProbeTs = 0;

/** The lag-accumulator update — the single path for both the production
 *  timer and deterministic test injection. First probe seeds the EMA;
 *  subsequent probes blend at α. Each probe also lands in the timestamped
 *  ring that backs the windowed max. */
export function ingestLagProbe(lagMs: number, now: number = Date.now()): void {
  const lag = Math.max(0, lagMs);
  lagEma = lagCount === 0 ? lag : lagEma + LAG_EMA_ALPHA * (lag - lagEma);
  lagRing[lagIdx] = lag;
  lagRingTs[lagIdx] = now;
  lagIdx = (lagIdx + 1) % LAG_RING_SLOTS;
  lagCount = Math.min(lagCount + 1, LAG_RING_SLOTS);
  lastLagProbeTs = now;
}

function lagWindowMax(now: number): number {
  let max = 0;
  for (let i = 0; i < LAG_RING_SLOTS; i++) {
    if (lagRingTs[i] !== 0 && now - lagRingTs[i] <= LAG_WINDOW_MS && lagRing[i] > max) {
      max = lagRing[i];
    }
  }
  return max;
}

let lagTimer: NodeJS.Timeout | null = null;

function startLagProbe(): void {
  if (lagTimer) return;
  // Drift is measured on the monotonic clock so a wall-clock step (NTP) can
  // never read as event-loop starvation; the ring is stamped in wall time so
  // the window lines up with the tickAssess() `now`.
  let prev = performance.now();
  lagTimer = setInterval(() => {
    const t = performance.now();
    ingestLagProbe(Math.max(0, t - prev - LAG_PROBE_INTERVAL_MS), Date.now());
    prev = t;
  }, LAG_PROBE_INTERVAL_MS);
  lagTimer.unref();
}

/* ── /proc + statfs readers (null over fabrication, never throw) ─────────── */

function readLoadAvg(): { load1: number; load5: number } | null {
  try {
    const parts = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    const load1 = Number(parts[0]);
    const load5 = Number(parts[1]);
    return Number.isFinite(load1) && Number.isFinite(load5) ? { load1, load5 } : null;
  } catch {
    return null;
  }
}

function readMemAvailableMb(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function readDataDiskFreeMb(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? freeBytes / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

/** Per-probe overrides for tests: any reader left unset falls through to the
 *  real /proc + statfs path. */
export interface VitalsReaders {
  load?: () => { load1: number; load5: number } | null;
  memAvailableMb?: () => number | null;
  dataDiskFreeMb?: () => number | null;
}

/* ── pure hysteresis ─────────────────────────────────────────────────────── */

/** High-is-bad band (lag, load): fires at ≥ threshold; a held level survives
 *  until the value drops past `clear(threshold)`, stepping down one band per
 *  assessment. */
function bandHigh(
  v: number, warnT: number, critT: number, held: VitalsLevel,
  clear: (t: number) => number,
): VitalsLevel {
  if (v >= critT) return 'crit';
  if (held === 'crit' && v >= clear(critT)) return 'crit';
  if (v >= warnT) return 'warn';
  if (held !== 'ok' && v >= clear(warnT)) return 'warn';
  return 'ok';
}

/** Low-is-bad band (mem, disk): fires below the threshold; a held level
 *  survives until the value rises past `clear(threshold)`. */
function bandLow(
  v: number, warnT: number, critT: number, held: VitalsLevel,
  clear: (t: number) => number,
): VitalsLevel {
  if (v < critT) return 'crit';
  if (held === 'crit' && v <= clear(critT)) return 'crit';
  if (v < warnT) return 'warn';
  if (held !== 'ok' && v <= clear(warnT)) return 'warn';
  return 'ok';
}

const lagClear = (t: number): number => t * VITALS_LAG_CLEAR_FRAC;
const memDiskClear = (t: number): number => t * VITALS_MEMDISK_CLEAR_FRAC;
const loadClear = (t: number): number => t - VITALS_LOAD_CLEAR_DELTA;

const RANK: Record<VitalsLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** Pure hysteresis over one sample. `held` carries the previous per-dimension
 *  levels (null ⇒ all 'ok'). A null dimension is 'ok' unconditionally — an
 *  unreadable gauge can neither raise nor hold an alert; the always-readable
 *  lag dimension is the backstop. Reasons render in an operator alert, so
 *  each carries the measured value and the threshold it is judged against;
 *  a level held only by hysteresis (raw value already back inside the line)
 *  is marked [holding]. */
export function assessVitals(s: VitalsSample, held: VitalsAssessment | null): VitalsAssessment {
  const h = held ?? { level: 'ok' as const, reasons: [], lag: 'ok' as const, mem: 'ok' as const, disk: 'ok' as const, load: 'ok' as const };

  const lag = bandHigh(s.evLoopLagMs, VITALS_LAG_WARN_MS, VITALS_LAG_CRIT_MS, h.lag, lagClear);
  const mem = s.memAvailableMb === null ? 'ok'
    : bandLow(s.memAvailableMb, VITALS_MEM_WARN_MB, VITALS_MEM_CRIT_MB, h.mem, memDiskClear);
  const disk = s.dataDiskFreeMb === null ? 'ok'
    : bandLow(s.dataDiskFreeMb, VITALS_DISK_WARN_MB, VITALS_DISK_CRIT_MB, h.disk, memDiskClear);
  const load = s.load1 === null ? 'ok'
    : bandHigh(s.load1, VITALS_LOAD_WARN, VITALS_LOAD_CRIT, h.load, loadClear);

  const holding = (lvl: VitalsLevel, raw: VitalsLevel): string =>
    RANK[raw] < RANK[lvl] ? ' [holding]' : '';

  const reasons: string[] = [];
  if (lag !== 'ok') {
    const raw = bandHigh(s.evLoopLagMs, VITALS_LAG_WARN_MS, VITALS_LAG_CRIT_MS, 'ok', lagClear);
    const t = lag === 'crit' ? `crit ≥ ${VITALS_LAG_CRIT_MS} ms` : `warn ≥ ${VITALS_LAG_WARN_MS} ms`;
    reasons.push(
      `event-loop lag ${Math.round(s.evLoopLagMs)} ms (${t}; 60s max ${Math.round(s.evLoopLagMaxMs)} ms)`
      + `${holding(lag, raw)} — the host is starving this process of CPU`,
    );
  }
  if (mem !== 'ok' && s.memAvailableMb !== null) {
    const raw = bandLow(s.memAvailableMb, VITALS_MEM_WARN_MB, VITALS_MEM_CRIT_MB, 'ok', memDiskClear);
    const t = mem === 'crit' ? `crit < ${VITALS_MEM_CRIT_MB} MB` : `warn < ${VITALS_MEM_WARN_MB} MB`;
    reasons.push(
      `MemAvailable ${Math.round(s.memAvailableMb)} MB (${t})`
      + `${holding(mem, raw)} — a co-tenant is eating host memory`,
    );
  }
  if (disk !== 'ok' && s.dataDiskFreeMb !== null) {
    const raw = bandLow(s.dataDiskFreeMb, VITALS_DISK_WARN_MB, VITALS_DISK_CRIT_MB, 'ok', memDiskClear);
    const t = disk === 'crit' ? `crit < ${VITALS_DISK_CRIT_MB} MB` : `warn < ${VITALS_DISK_WARN_MB} MB`;
    reasons.push(
      `data disk free ${Math.round(s.dataDiskFreeMb)} MB (${t})`
      + `${holding(disk, raw)} — the shared disk is filling`,
    );
  }
  if (load !== 'ok' && s.load1 !== null) {
    const raw = bandHigh(s.load1, VITALS_LOAD_WARN, VITALS_LOAD_CRIT, 'ok', loadClear);
    const t = load === 'crit' ? `crit ≥ ${VITALS_LOAD_CRIT}` : `warn ≥ ${VITALS_LOAD_WARN}`;
    reasons.push(
      `load1 ${s.load1.toFixed(2)} (${t})`
      + `${holding(load, raw)} — host CPU is oversubscribed`,
    );
  }

  const level = ([lag, mem, disk, load] as VitalsLevel[])
    .reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as VitalsLevel);
  return { level, reasons, lag, mem, disk, load };
}

/* ── module holder ───────────────────────────────────────────────────────── */

let dataDirHeld: string | null = null;
let lastSample: VitalsSample | null = null;
let lastAssessment: VitalsAssessment | null = null;

/** Idempotent; starts the lag probe (the only timer, unref()'d — it never
 *  keeps the process alive). The /proc + statfs sampler has no timer of its
 *  own: it rides the host's 60 s tick via tickAssess(). */
export function startVitals(dataDir: string): void {
  dataDirHeld = dataDir;
  startLagProbe();
}

/** The freshest stored sample, or null before the first tickAssess() or when
 *  the store has gone stale (assessment tick dead > 5 min). */
export function liveVitals(now: number = Date.now()): VitalsSample | null {
  if (!lastSample || now - lastSample.ts > VITALS_MAX_AGE_MS) return null;
  return lastSample;
}

/** sample → assess → store; called by the host 60 s tick. Returns null (and
 *  stores nothing) before the first lag probe or when the lag probe has been
 *  silent > 5 min — with the backstop gauge dead, an assessment would be
 *  fabrication. `readers` is the test override; production passes nothing. */
export function tickAssess(now: number = Date.now(), readers: VitalsReaders = {}): VitalsAssessment | null {
  if (lagCount === 0 || now - lastLagProbeTs > VITALS_MAX_AGE_MS) return null;
  const load = readers.load ? readers.load() : readLoadAvg();
  const memAvailableMb = readers.memAvailableMb ? readers.memAvailableMb() : readMemAvailableMb();
  const dataDiskFreeMb = readers.dataDiskFreeMb ? readers.dataDiskFreeMb()
    : dataDirHeld !== null ? readDataDiskFreeMb(dataDirHeld) : null;
  const sample: VitalsSample = {
    evLoopLagMs: lagEma,
    evLoopLagMaxMs: lagWindowMax(now),
    load1: load?.load1 ?? null,
    load5: load?.load5 ?? null,
    memAvailableMb,
    dataDiskFreeMb,
    ts: now,
  };
  lastSample = sample;
  lastAssessment = assessVitals(sample, lastAssessment);
  return lastAssessment;
}

export function currentAssessment(): VitalsAssessment | null {
  return lastAssessment;
}

/** True while the held level is 'crit' — the host tick consults this to shed
 *  discretionary work (analytics, backtests, forecast refreshes) and keep the
 *  poll→alert→broadcast path breathing. */
export function degradedMode(): boolean {
  return currentAssessment()?.level === 'crit';
}

/** test-only — stop the timer and clear all holders between cases. */
export function _resetVitalsForTest(): void {
  if (lagTimer) { clearInterval(lagTimer); lagTimer = null; }
  lagRing.fill(0);
  lagRingTs.fill(0);
  lagIdx = 0;
  lagCount = 0;
  lagEma = 0;
  lastLagProbeTs = 0;
  dataDirHeld = null;
  lastSample = null;
  lastAssessment = null;
}
