/**
 * v1.200.1 — THE YEAR WALKED THROUGH THE REAL DECISIONS. Each evening plan of legacyIdentityFixtures, through the real armFromPlan,
 * decideActuation and decideForceCharge, one minute at a time, on an emulated plant: a 92.16 × 0.944 kWh pool, hourly P50 loads, the panel's
 * measured OFF at its ceiling, the fixture's charge cap. It imports nothing v1.200.1 added, so the same walk runs on a3588d96, which is how
 * lineStanding.walkIdentity.json was made (STANDING_WALK_WRITE=1, on that tree only).
 *
 * Unmodelled, and said so wherever these figures are quoted: the ON-reading latch (the code path of a written night, unmeasured), the re-entry
 * band after the close, and every reading is the reading of the tick. The grid is an input (GridAt): present on every tick unless a walk
 * says otherwise, and the plant does not stop charging with it (a walk with the grid lost counts decisions, never the pool). A walk can read
 * it from a panel's last quota instead (panelGridAt), a sample that may predate the tick.
 */
import { computeNightChargePlan, buildNightChargeInputs, setExpectedBuyObserverForTesting, type NightChargePlan, type ExpectedBuy } from '../../src/nightChargeAdvisor.js';
import { armFromPlan, emptyActuationState, decideActuation, writeWindowEndMs, type NightActuationState } from '../../src/nightChargeActuator.js';
import * as nfc from '../../src/nightForceCharge.js';
import { decideForceCharge, forceChargeRateKw, evDisplacedPackKwh } from '../../src/nightForceCharge.js';
import { nextOnPeakStartMs } from '../../src/chargeWindows.js';
import { resolveGridBackstop } from '../../src/gridState.js';
import { legacyIdentityCases, MODEL } from './legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './measuredCushionLineFigures.js';

const MIN = 60_000;
const H = 3_600_000;
const NAME = 92.16;
const LEG = 0.927;
const DIS = 0.94;
const CAP = NAME * 0.944;
const CORES_KW = 16.5;

type Deps = ReturnType<typeof legacyIdentityCases>[number]['deps'] & Record<string, any>;
export type Basis = 'np' | 'm';
export type WalkCase = 'A' | 'B' | 'C' | 'O' | 'W';
export const WALK_HOURS_ALL = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
export const WALK_HOURS_SAMPLE = [4, 8, 12, 20];
/** What the grid reads on a tick, against the window open; omitted: present on every tick. */
export type GridAt = (t: number, open: number) => boolean | null;

/**
 * v1.200.1 — the grid as the tick reads it from one panel's last REST quota, not the grid of the tick: index.ts's gridPresent, tri-stated from
 * liveGridBackstop over the device list, through the real freshness gate and resolver (resolveGridBackstop, `declared` its GRID_AVAILABLE). The
 * quotas come every minute, `lagMs` before each tick (they and the ticks are both 60 s and unsynchronised), so the first tick of the window
 * reads a sample taken before the open. `sta(q, open)` is the gridSta the quota at q carries, null where the reply omits it; the last reply
 * that carried one before then is `carried`, as the store keeps it (lastGridReading). No grid flow on the main line: at a standing 50 with
 * the pool above it the house runs from the pool.
 */
export function panelGridAt(o: { sta: (q: number, open: number) => number | null; carried?: { sta: number; atMs: (open: number) => number }; lagMs?: number; declared?: boolean }): GridAt {
  const lag = o.lagMs ?? 30_000;
  return (t, open) => {
    const q = t - lag;
    const sta = o.sta(q, open);
    const last = sta != null ? { connected: sta === 1, sta, atMs: q } : o.carried != null ? { connected: o.carried.sta === 1, sta: o.carried.sta, atMs: o.carried.atMs(open) } : undefined;
    const panel = {
      sn: 'P1', deviceName: 'panel', productName: 'Smart Home Panel 2', online: true, contentStaleSinceMs: null, lastQuotaAtMs: q, lastUpdated: q, lastGridReading: last,
      projection: { kind: 'shp2', gridSta: sta, gridConnected: sta == null ? null : sta === 1, gridWatt: 0, sources: [], backupReserveSoc: 50, backupFullCapWh: 92_160, backupRemainWh: 55_296, backupBatPercent: 60 },
    };
    const g = resolveGridBackstop({ devices: { P1: panel } as never, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: o.declared === true, nowMs: t });
    return g.present ? true : g.presenceUnknown ? null : false;
  };
}

export interface WalkNight {
  close: number | null; onMin: number; reOns: number; onAt: number | null; onMode: string | null; bought: number;
  writes: { reserve: number; restore: number; ceiling: number; on: number }; push: string | null; onPool: number | null;
  applied: boolean; verified: boolean; standing: boolean; ask: number | null; offReason: string | null; ceilRestored: boolean;
  closed: string | null; account: string | null; wMin: number; gridLost: number;
}
export interface WalkRow extends WalkNight {
  label: string; b: Basis; h: number; cs: WalkCase; own: number; L: number | null; reason: string | null; armedAsk: number | null;
  shortfall?: boolean; stands?: boolean; rationale?: string;
  /** v1.205.0 (review) — the plan is a line night the COST force-charge carries whose close past the stop the window's reach
   *  CAPPED (H1: ExpectedBuy.closeReachCapped, through the planner's test seam; no plan field carries it), not merely one on a
   *  deliverable-bound window: what W1's excluded list may hold beside a 'lateStart' night. Never digested. */
  capped?: boolean;
}

const live = (d: Deps): Deps => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50 });
/** v1.205.0 (review) — the plans whose median walk (ExpectedBuy) capped a cost-carried close past the stop at the window's reach. */
const reachCapped = new WeakSet<object>();
const planOf = (d: Deps, b: Basis, h: number, floor: number | null): NightChargePlan & Record<string, any> => {
  const seen: { e: ExpectedBuy | null } = { e: null };
  setExpectedBuyObserverForTesting((e) => { seen.e = e; });
  try {
    const p = computeNightChargePlan(buildNightChargeInputs({
      ...live(d), outageCushionHours: h, ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: true, ...(floor != null ? { reserveFloorPct: floor } : {}),
    } as never)!) as NightChargePlan & Record<string, any>;
    if (seen.e?.closeReachCapped === true) reachCapped.add(p);
    return p;
  } finally { setExpectedBuyObserverForTesting(null); }
};

function loadKwAt(d: Deps, t: number): number {
  const he = Math.floor(t / H) * H;
  const b = d.bandHours.find((x: any) => x.ts === he);
  if (b?.loadP50W != null) return b.loadP50W / 1000;
  for (const r of d.dayRollups ?? []) { const x = r.hours.find((y: any) => y.ts === he); if (x) return x.loadW / 1000; }
  return 2.2;
}

/** One night. `reserveOpen` is what the panel reads at the open, whatever the plan read; `p0` the pool there. */
export function walkNight(p: Record<string, any>, d: Deps, rec0: NightActuationState, cfg: { reserveOpen: number; p0: number; grid?: GridAt }): WalkNight {
  let s: any = { ...rec0 };
  const W0 = s.windowStartMs as number;
  const W1 = s.windowEndMs as number;
  const gates = { cost: d.forceChargeEligible === true && live(d).forceChargeEligible === true, line: true };
  const capKw = d.gridInputCapKw ?? 17;
  const pCap = (d.chargeCapKw ?? 17.8) * LEG;
  let pack = (cfg.p0 / 100) * CAP;
  let reserve = cfg.reserveOpen;
  let ceiling = 100;
  let pendingC: number | null = null;
  let pendingR: number | null = null;
  let on = false;
  let onEff: number | null = null;
  let onMin = 0;
  let reOns = 0;
  let onAt: number | null = null;
  let onMode: string | null = null;
  let onPool: number | null = null;
  let bought = 0;
  let push: string | null = null;
  let gridLost = 0;
  const writes = { reserve: 0, restore: 0, ceiling: 0, on: 0 };
  const tail: number[] = [];
  const slots = [1, 2, 3];
  const evKwh = p.evContention?.windowEvKwh;
  const peak = p.evContention?.peakEvKw;
  for (let t = W0; t < W1 + 30 * MIN; t += MIN) {
    if (pendingC != null) { ceiling = pendingC; pendingC = null; }
    if (pendingR != null) { reserve = pendingR; pendingR = null; }
    if (onEff != null && t >= onEff) { on = true; onEff = null; }
    const seen = Math.round((pack / CAP) * 100);
    if (t >= W1 - 15 * MIN && t < W1) tail.push(seen);
    const load = loadKwAt(d, t);
    const grid = cfg.grid == null ? true : cfg.grid(t, W0);
    const a = decideActuation(s, t, { mode: 'supervised', writeReady: false, currentReservePct: reserve, socCoherent: true, vitalsRed: false, gridPresent: grid }) as { kind: string; targetPct?: number; restorePct?: number };
    if (a.kind === 'apply') { s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: reserve, appliedAtMs: t, priorReservePct: reserve, applyLastAttemptMs: t }; writes.reserve++; pendingR = Math.min(50, a.targetPct!); }
    else if (a.kind === 'applyVerified') s = { ...s, applyVerifiedAtMs: t };
    else if (a.kind === 'revert') { s = { ...s, revertedAtMs: t, revertLastAttemptMs: t }; writes.restore++; pendingR = a.restorePct!; }
    else if (a.kind === 'revertVerified') s = { ...s, revertVerifiedAtMs: t };
    else if (a.kind === 'reserveStanding') s = { ...s, reserveStandingAtMs: t };
    else if (a.kind === 'gridLost') { s = { ...s, gridLostAtMs: t }; gridLost++; }
    else if (a.kind !== 'none') throw new Error(`action ${a.kind}`);
    const rate = forceChargeRateKw({ gridCapKw: d.gridInputCapKw ?? null, houseLoadKw: load, legEff: LEG, slotCount: 3 });
    const evD = typeof evKwh === 'number' && evKwh > 0 ? evDisplacedPackKwh({ evKwh, peakEvKw: peak ?? null, rateKw: rate, unboundedRateKw: d.gridInputCapKw != null ? Math.max(1, (d.gridInputCapKw - load) * LEG) : null, legEff: LEG }) : null;
    const o: any = {
      enabled: gates.cost, lineEnabled: gates.line, gridPresent: grid, gridStaLost: false, slotsOn: on ? slots : [], reservePct: reserve, connectedSlots: slots, vitalsRed: false, socCoherent: true,
      slotSocPct: { 1: seen, 2: seen, 3: seen }, ceilingReadbackPct: ceiling, poolSocPct: seen, fullKwh: NAME, chargeRateKw: rate, evDisplacedKwh: evD,
    };
    const obs = nfc.lineNightObservations(s, t, o);
    if (obs != null) s = { ...s, ...obs };
    const f = decideForceCharge(s, t, o) as any;
    if (f.kind === 'none' && push == null) { const r = nfc.lineAtRiskPushDue(s, t, o); if (r != null) { push = r.cause; s = { ...s, forceChargeLineAtRiskPushedAtMs: t }; } }
    if (f.kind === 'syncCeiling') { s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? f.prior, forceChargeCeilingSyncedPct: f.pct }; pendingC = f.pct; writes.ceiling++; }
    else if (f.kind === 'on') { s = { ...s, ...nfc.forceChargeOnStamp(s, t, f.slots, gates), forceChargeOnLastAttemptMs: t }; onEff = t; writes.on++; onAt ??= t; onMode = s.forceChargeMode; onPool ??= seen; }
    else if (f.kind === 'onVerified') s = { ...s, forceChargeOnVerifiedAtMs: t };
    else if (f.kind === 'lineReOn') { s = { ...s, forceChargeLineReOns: s.forceChargeLineReOns + 1, forceChargeLineReOnAtMs: t, forceChargeLineReOnSlots: [...f.slots] }; onEff = t; reOns++; writes.on++; }
    else if (f.kind === 'lineReOnChecked') s = { ...s, ...nfc.lineReOnCheckedStamp(s, t, f) };
    else if (f.kind === 'off') { s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: f.reason, forceChargeOffLastAttemptMs: t }; on = false; onEff = null; }
    else if (f.kind === 'offVerified') s = { ...s, forceChargeOffVerifiedAtMs: t };
    else if (f.kind === 'restoreCeiling') { s = { ...s, forceChargeCeilingRestoreAttempts: s.forceChargeCeilingRestoreAttempts + 1, forceChargeCeilingRestoreLastAttemptMs: t }; pendingC = f.pct; writes.ceiling++; }
    else if (f.kind === 'ceilingRestored') s = { ...s, forceChargeCeilingRestoredAtMs: t };
    const inWin = t < W1;
    const rateP = Math.min(Math.max(1, (capKw - load) * LEG), CORES_KW, pCap);
    const resKwh = (reserve / 100) * CAP;
    if (on && pack < (ceiling / 100) * CAP) { const g = Math.min((ceiling / 100) * CAP - pack, rateP * (MIN / H)); pack += g; bought += g / LEG; onMin++; }
    else {
      if (on) { on = false; onMin++; } // the panel's own OFF at its ceiling, the measured shape
      if (inWin && pack < resKwh) { const g = Math.min(resKwh - pack, rateP * (MIN / H)); pack += g; bought += g / LEG; }
      else if (pack > resKwh) pack = Math.max(resKwh, pack - (load / DIS) * (MIN / H));
    }
  }
  tail.sort((x, y) => x - y);
  return {
    close: tail.length > 0 ? tail[tail.length >> 1] : null, onMin, reOns, onAt: onAt == null ? null : Math.round((W1 - onAt) / MIN), onMode,
    bought: Math.round(bought * 10) / 10, writes, push, onPool, applied: s.appliedAtMs != null, verified: s.applyVerifiedAtMs != null,
    standing: s.reserveStandingAtMs != null, ask: s.forceChargeLineAskPct, offReason: s.forceChargeOffReason,
    ceilRestored: s.forceChargeCeilingPriorPct == null || s.forceChargeCeilingRestoredAtMs != null,
    closed: nfc.forceChargeStartClosed(s, W1 + 30 * MIN, gates), account: nfc.lineCloseAccountDue(s, W1 + 30 * MIN), wMin: Math.round((W1 - W0) / MIN), gridLost,
  };
}

/** The five cases: A, 50 at the plan and the open; B, 50 at the plan, the plant's own floor at the open; C, the own floor at the plan, 50 at the open; O, the plant's
 *  own floor throughout (no move); W, 49 throughout (the written control of A). */
export function walkYear(hours: readonly number[], cases: ReadonlySet<WalkCase>, grid?: GridAt): WalkRow[] {
  const rows: WalkRow[] = [];
  for (const c of legacyIdentityCases().filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (const h of hours) {
    const d0 = live(c.deps as Deps);
    const own = d0.reserveFloorPct as number;
    const p50 = planOf(d0, b, h, 50);
    const pOwn = planOf(d0, b, h, null);
    const arm = (p: Record<string, any>, liveR: number) => armFromPlan(emptyActuationState(), c.label.slice(0, 10), p as never, d0.nowMs as number, liveR, d0.forceChargeEligible === true, p.window ? nextOnPeakStartMs(MODEL as never, p.window.startMs) : null, true);
    const base = { label: c.label, b, h, own };
    const rA = arm(p50, 50);
    const lineA = p50.chargeTonight && Math.ceil((p50.cushionLineSocPct ?? 0) - 1e-9) > 50;
    const row = (cs: WalkCase, p: Record<string, any>, rec: NightActuationState, reserveOpen: number, p0: number, extra: Partial<WalkRow> = {}) => rows.push({
      ...base, cs, L: p.cushionLineSocPct ?? null, reason: p.cushionEnvelopeReason ?? null, armedAsk: p.forceChargeLine?.askPct ?? null, shortfall: p.cushionShortfall === true,
      // review — a cost-carried close the reach capped: never a line-mode walk, whatever closeReachCapped says.
      capped: reachCapped.has(p) && p.forceChargeLine != null && p.expectedForceChargeMode !== 'line',
      ...extra, ...walkNight(p, d0, rec, { reserveOpen, p0, grid }),
    });
    if (rA && lineA && cases.has('A')) row('A', p50, rA, 50, Math.max(50, p50.expectedStartSocPct ?? 50), { stands: p50.lineReserveStands === true });
    if (rA && lineA && cases.has('B')) row('B', p50, rA, own, pOwn.expectedStartSocPct ?? d0.socNowPct, { stands: p50.lineReserveStands === true });
    if (cases.has('O')) { const rO = arm(pOwn, own); if (rO) row('O', pOwn, rO, own, Math.max(own, pOwn.expectedStartSocPct ?? own), { rationale: pOwn.rationale }); }
    if (rA && lineA && cases.has('W')) { const p49 = planOf(d0, b, h, 49); const rW = arm(p49, 49); if (rW) row('W', p49, rW, 49, Math.max(49, p49.expectedStartSocPct ?? 49)); }
    if (cases.has('C')) { const rC = arm(pOwn, own); if (rC && rC.forceChargeLineAskPct != null) row('C', pOwn, rC, 50, pOwn.expectedStartSocPct ?? d0.socNowPct); }
  }
  return rows;
}

export const closeUnder = (r: Pick<WalkRow, 'close' | 'L'>): boolean => r.close != null && r.L != null && r.close < Math.min(r.L, 100) - 0.05;
export { writeWindowEndMs };
