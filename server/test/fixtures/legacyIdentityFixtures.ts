/**
 * legacyIdentityFixtures.ts — a year of overnight night-charge plans, built the way index.ts
 * builds them (recomputeNightChargePlan), for legacyIdentity.test.ts.
 *
 * Every case is deterministic (a seeded generator per day) and uses only the planner API that
 * existed before R2 (buildNightChargeInputs, computeNightChargePlan, the window helpers and the
 * APS model), so the same cases can be run through the planner as it stood before R2 to produce
 * the golden digests (legacyIdentity.golden.json) and through the planner as it stands now.
 *
 * The cases span 2026-10-13 .. 2027-10-12, three plans a day — the 21:30 evening plan, a 13:00
 * recompute and a 01:30 recompute (inside the window on a weeknight) — with the inputs varied the
 * way the live ones vary: SoC, floor, objective and ceiling, force-charge eligibility, a committed
 * EV session, the grid-input envelope, the islanded load, the learned de-bias and cost-load
 * factor, the season's sun and load, cloud, and the odd incomplete basis. Two more reproduce the
 * nights the expected-buy and cost-ceiling work was measured on: 2026-10-12 (nightChargeExpectedBuy
 * .test.ts) and 2026-09-29/30 (costCeilingLoadDebias.test.ts).
 *
 * PV is zero from 19:00 to 05:00 in every season (Phoenix: sunrise after 05:15 at the solstice),
 * so the overnight window never sees sun — the condition under which R2's PV terms are no-ops.
 */
import { createHash } from 'node:crypto';
import {
  buildNightChargeInputs, computeNightChargePlan, resolveCheapWindow, nextFullCheapWindow, longGapAhead,
  pessimisticPrePeakSurplus,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan,
} from '../../src/nightChargeAdvisor.js';
import { buildApsREvModel, rateAt } from '../../src/tariff.js';

const H = 3_600_000;
const POOL = 92.16;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h + 7, mi);
/** The Phoenix hour of a UTC ms. */
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const phxMonth = (ts: number): number => new Date(ts - 7 * H).getUTCMonth() + 1;

export const MODEL = buildApsREvModel();
export const periodIdAt = (ts: number): string => rateAt(MODEL, ts).periodId;
const isOnPeakAt = (ts: number): boolean => rateAt(MODEL, ts).isOnPeak;

/** mulberry32 — a small deterministic generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The season's sun: sunrise/sunset hour and peak kW (P50), by Phoenix month. */
function sunOf(month: number): { rise: number; set: number; peakKw: number } {
  if (month === 12 || month === 1) return { rise: 7, set: 18, peakKw: 8.5 };
  if (month === 11 || month === 2) return { rise: 7, set: 18, peakKw: 9.5 };
  if (month === 10 || month === 3) return { rise: 6, set: 19, peakKw: 11 };
  if (month === 4 || month === 9) return { rise: 6, set: 19, peakKw: 12 };
  return { rise: 5, set: 19, peakKw: 13 }; // May–Aug: the 05:00 hour has some sun, never the window
}

/** One day's generated conditions. */
interface Day {
  cloud: number; p10Frac: number; p90Frac: number; loadScale: number; summer: boolean;
}

function pvP50W(ts: number, day: Day): number {
  const h = phxHour(ts);
  const sun = sunOf(phxMonth(ts));
  if (h < sun.rise || h >= sun.set) return 0;
  return Math.round(sun.peakKw * 1000 * day.cloud * Math.sin(((h - sun.rise + 0.5) / (sun.set - sun.rise)) * Math.PI));
}
function houseLoadW(ts: number, day: Day): number {
  const h = phxHour(ts);
  const base = h < 6 ? 1900 : h < 12 ? 2300 : h < 17 ? (day.summer ? 4200 : 2600) : h < 22 ? (day.summer ? 4800 : 3300) : 2500;
  return Math.round(base * day.loadScale);
}

export interface IdentityCase {
  label: string;
  deps: NightChargeInputDeps;
}

/** The deps index.ts assembles at `nowMs` for the conditions `day`, `knobs`. */
function liveShapedDeps(nowMs: number, day: Day, k: {
  socNowPct: number; reserveFloorPct: number; objective: 'cost' | 'resilience'; costMaxSocPct: number;
  forceChargeEligible: boolean; ev: { kwh: number; startMs: number; expectedW: number } | null;
  gridInputCapKw: number | null; islandedLoadKw: number | null; outageCushionHours: number;
  chargeCapKw: number; p90Factor: number; buyDebias: number; costLoadFactor: number | null;
  calScoredDays: number; tier: 'forecast' | 'mixed' | 'climatology'; coverage: number; forecastPresent: boolean;
}): NightChargeInputDeps {
  const bandStart = Math.ceil(nowMs / H) * H;
  const evW = (ts: number): number => (k.ev && ts >= k.ev.startMs - 2 * H && ts < k.ev.startMs + 3 * H ? k.ev.expectedW : 0);
  const bandHours: NightForecastHour[] = [];
  const prob: Array<{ ts: number; p10W: number; p50W: number; p90W: number; loadW: number }> = [];
  for (let ts = bandStart; ts < bandStart + 24 * H; ts += H) {
    const p50 = pvP50W(ts, day);
    const forecastLoadW = houseLoadW(ts, day) + evW(ts);
    bandHours.push({
      ts,
      pvP10W: p50 * day.p10Frac,
      loadP90W: forecastLoadW * k.p90Factor,
      embeddedEvW: evW(ts) * k.p90Factor,
      loadP50W: forecastLoadW,
      pvP50W: p50,
    });
    prob.push({ ts, p10W: p50 * day.p10Frac, p50W: p50, p90W: p50 * day.p90Frac, loadW: forecastLoadW });
  }
  const rollHours: Array<{ ts: number; pvW: number; loadW: number }> = [];
  for (let ts = bandStart + 24 * H; ts < bandStart + 96 * H; ts += H) {
    rollHours.push({ ts, pvW: pvP50W(ts, day), loadW: houseLoadW(ts, day) });
  }
  const dayRollups = [0, 1, 2].map((i) => ({ daysAhead: i + 1, hours: rollHours.slice(i * 24, (i + 1) * 24) }));

  // index.ts: the window, the next one (96 h), the morning surplus, the long gap, the P10 pre-peak.
  const window = resolveCheapWindow(periodIdAt, nowMs, 'overnight', 30);
  const windowEndMs = window?.endMs ?? nowMs;
  const nextRechargeMs = resolveCheapWindow(periodIdAt, windowEndMs + H, 'overnight', 96)?.startMs ?? null;
  const morning = legacyMorningSurplus(prob, window, windowEndMs);
  const nightLongGap = longGapAhead(window, window ? nextFullCheapWindow(periodIdAt, window.endMs, 'overnight') : null);
  const prePeak = window
    ? pessimisticPrePeakSurplus({ hours: prob.map((p) => ({ ts: p.ts, p10W: p.p10W, loadW: p.loadW })), windowEndMs: window.endMs, isOnPeakAt }).kwh
    : null;
  const costSurplusLoad = k.costLoadFactor == null || morning.p50 == null || morning.p90 == null ? null : {
    factor: k.costLoadFactor, basis: 'measured' as const, samples: 9,
    p50Kwh: Math.round(morning.p50 * (2 - k.costLoadFactor) * 100) / 100,
    p90Kwh: Math.round(morning.p90 * (2 - k.costLoadFactor) * 100) / 100,
  };
  return {
    nowMs, fullKwh: POOL, socNowPct: k.socNowPct, reserveFloorPct: k.reserveFloorPct, cushionPct: 15, socCoherent: true,
    islandedLoadKw: k.islandedLoadKw, outageCushionHours: k.outageCushionHours, islandedLoadSafety: 1.25,
    objectiveMode: k.objective, costMaxSocPct: k.costMaxSocPct,
    legEff: Math.sqrt(0.86), dischargeEff: 0.94, chargeCapKw: k.chargeCapKw, gridInputCapKw: k.gridInputCapKw,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours, dayRollups, realizedDailyErrHalfFrac: 0.12, nextRechargeMs,
    ev: k.ev ? { p90SessionKwh: k.ev.kwh, chargeStartMs: k.ev.startMs, sessionCount: 14 } : { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 },
    evMaxLoadW: 11520,
    confidenceTier: k.tier, forecastPresent: k.forecastPresent, calScoredDays: k.calScoredDays, minCalScoredDays: 14,
    bandCoverageFrac: k.coverage,
    morningPvSurplusP90Kwh: morning.p90, morningPvSurplusP50Kwh: morning.p50,
    longGapAhead: nightLongGap, prePeakPvSurplusP10Kwh: prePeak, costSurplusLoad,
    minBuyKwh: 1,
    buyDebiasFactor: k.buyDebias, buyDebiasBasis: k.buyDebias > 1 ? 'measured' : 'default', buyDebiasSamples: k.buyDebias > 1 ? 8 : 0,
    forceChargeEligible: k.forceChargeEligible,
  };
}

/** The morning surplus loop index.ts ran inline before R2, verbatim (window close → +14 h). */
export function legacyMorningSurplus(
  prob: ReadonlyArray<{ ts: number; p50W: number; p90W: number; loadW: number }>,
  window: { startMs: number; endMs: number } | null,
  windowEndMs: number,
): { p90: number | null; p50: number | null } {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  let morningSurplusKwh = 0;
  let morningSurplusP50Kwh = 0;
  let morningP50Complete = true;
  let morningHasData = false;
  const morningEndMs = windowEndMs + 14 * H;
  if (window) {
    for (const pb of prob) {
      if (pb.ts < windowEndMs || pb.ts >= morningEndMs) continue;
      morningHasData = true;
      morningSurplusKwh += Math.max(0, pb.p90W - pb.loadW) / 1000;
      if (typeof pb.p50W === 'number' && Number.isFinite(pb.p50W)) {
        morningSurplusP50Kwh += Math.max(0, pb.p50W - pb.loadW) / 1000;
      } else {
        morningP50Complete = false;
      }
    }
  }
  return {
    p90: morningHasData ? round2(morningSurplusKwh) : null,
    p50: morningHasData && morningP50Complete ? round2(morningSurplusP50Kwh) : null,
  };
}

/** A year of live-shaped cases: three a day from 2026-10-13. */
function yearCases(): IdentityCase[] {
  const out: IdentityCase[] = [];
  const first = Date.UTC(2026, 9, 13);
  for (let i = 0; i < 365; i++) {
    const dayUtc = new Date(first + i * 86_400_000);
    const y = dayUtc.getUTCFullYear(), mo = dayUtc.getUTCMonth() + 1, d = dayUtc.getUTCDate();
    const r = rng(0x5eed + i * 7919);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const day: Day = {
      cloud: 0.25 + 0.75 * r(), p10Frac: 0.4 + 0.4 * r(), p90Frac: 1.1 + 0.3 * r(),
      loadScale: 0.8 + 0.5 * r(), summer: mo >= 5 && mo <= 9,
    };
    const objective = r() < 0.65 ? 'cost' as const : 'resilience' as const;
    const costMaxSocPct = pick([50, 70, 80, 90, 90, 95]);
    const evOn = r() < 0.45;
    const knobs = {
      socNowPct: Math.round(15 + 80 * r()),
      reserveFloorPct: pick([10, 16, 16, 20, 30]),
      objective, costMaxSocPct,
      forceChargeEligible: objective === 'cost' && costMaxSocPct > 50 && r() < 0.85,
      ev: evOn ? { kwh: Math.round(8 + 32 * r()), startMs: phx(y, mo, d, pick([21, 22, 23])) + pick([0, 1, 2, 3]) * H, expectedW: Math.round(2000 + 5000 * r()) } : null,
      gridInputCapKw: r() < 0.75 ? 17 : null,
      islandedLoadKw: r() < 0.8 ? Math.round((0.8 + 2.2 * r()) * 100) / 100 : null,
      outageCushionHours: pick([4, 4, 8]),
      chargeCapKw: pick([7.2, 14.4, 17.8, 17.8]),
      p90Factor: Math.round((1.15 + 0.45 * r()) * 100) / 100,
      buyDebias: r() < 0.3 ? Math.round((1.1 + 0.4 * r()) * 1000) / 1000 : 1,
      costLoadFactor: r() < 0.5 ? Math.round((0.7 + 0.3 * r()) * 1000) / 1000 : null,
      calScoredDays: r() < 0.03 ? 9 : 30,
      tier: r() < 0.03 ? 'climatology' as const : r() < 0.2 ? 'mixed' as const : 'forecast' as const,
      coverage: r() < 0.04 ? 0.7 : 0.85,
      forecastPresent: r() >= 0.02,
    };
    const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ label: `${ymd} 21:30`, deps: liveShapedDeps(phx(y, mo, d, 21, 30), day, knobs) });
    out.push({ label: `${ymd} 13:00`, deps: liveShapedDeps(phx(y, mo, d, 13), day, { ...knobs, socNowPct: Math.min(100, knobs.socNowPct + 10) }) });
    out.push({ label: `${ymd} +1 01:30`, deps: liveShapedDeps(phx(y, mo, d, 25, 30), day, { ...knobs, socNowPct: Math.max(10, knobs.socNowPct - 8) }) });
  }
  return out;
}

/* ── 2026-10-12 (nightChargeExpectedBuy.test.ts) ────────────────────────── */

function case1012(over: Partial<NightChargeInputDeps>): NightChargeInputDeps {
  const p = (mo: number, d: number, h: number, mi = 0) => phx(2026, mo, d, h, mi);
  const NOW = p(10, 12, 21, 30), WIN_START = p(10, 13, 0), WIN_END = p(10, 13, 5), NEXT_WINDOW = p(10, 13, 23);
  const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
  const pvKw = (h: number): number => (h >= 7 && h < 18 ? 6 * Math.sin(((h - 7 + 0.5) / 11) * Math.PI) : 0);
  const bandHours: NightForecastHour[] = [];
  for (let ts = p(10, 12, 21); ts < NEXT_WINDOW; ts += H) {
    const hour = phxHour(ts);
    const forecastLoadW = houseKw(hour) * 1000;
    const p50W = pvKw(hour) * 1000;
    bandHours.push({ ts, pvP10W: p50W * 0.8, loadP90W: forecastLoadW * 1.35, embeddedEvW: 0, loadP50W: forecastLoadW, pvP50W: p50W });
  }
  return {
    nowMs: NOW, fullKwh: POOL, socNowPct: 53, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt: (ms) => (ms >= WIN_START && ms < WIN_END) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
    cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours, dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: NEXT_WINDOW,
    ev: { p90SessionKwh: 19.3, chargeStartMs: p(10, 12, 21), sessionCount: 12 },
    evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: 30, morningPvSurplusP50Kwh: 18.06, longGapAhead: false, minBuyKwh: 1,
    buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true,
    ...over,
  };
}

/* ── 2026-09-29/30 (costCeilingLoadDebias.test.ts's morning) ─────────────── */

/** The 09-30 morning, 05:00-18:00 (W): P50 PV and the forecast load. */
export const P50_0930_W = [0, 94, 608, 2647, 4725, 6276, 6635, 6695, 6243, 5274, 3938, 2057, 573, 21];
export const LOAD_0930_W = [2188, 1864, 1646, 2068, 1851, 2158, 2202, 2927, 3228, 4020, 3435, 3738, 3205, 2978];

function case0929(over: Partial<NightChargeInputDeps>, socNowPct: number, pvScale: number): NightChargeInputDeps {
  const NOW = phx(2026, 9, 29, 21, 30);
  const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
  const loadW = (h: number): number => (h >= 5 && h <= 18 ? LOAD_0930_W[h - 5] : houseKw(h) * 1000);
  const pvW = (h: number): number => (h >= 5 && h <= 18 ? P50_0930_W[h - 5] * pvScale : 0);
  const bandHours: NightForecastHour[] = [];
  const prob: Array<{ ts: number; p10W: number; p50W: number; p90W: number; loadW: number }> = [];
  for (let ts = phx(2026, 9, 29, 22); ts < phx(2026, 9, 30, 22); ts += H) {
    const h = phxHour(ts);
    bandHours.push({ ts, pvP10W: pvW(h) * 0.8, loadP90W: loadW(h) * 1.35, embeddedEvW: 0, loadP50W: loadW(h), pvP50W: pvW(h) });
    prob.push({ ts, p10W: pvW(h) * 0.8, p50W: pvW(h), p90W: pvW(h) * 1.3, loadW: loadW(h) });
  }
  const hours = [] as Array<{ ts: number; pvW: number; loadW: number }>;
  for (let ts = phx(2026, 9, 30, 22); ts < phx(2026, 10, 2, 0); ts += H) hours.push({ ts, pvW: pvW(phxHour(ts)), loadW: loadW(phxHour(ts)) });
  const window = resolveCheapWindow(periodIdAt, NOW, 'overnight', 30)!;
  const morning = legacyMorningSurplus(prob, window, window.endMs);
  return {
    nowMs: NOW, fullKwh: POOL, socNowPct, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.66, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours, dayRollups: [{ daysAhead: 1, hours }], realizedDailyErrHalfFrac: 0.1,
    nextRechargeMs: resolveCheapWindow(periodIdAt, window.endMs + H, 'overnight', 96)?.startMs ?? null,
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: morning.p90, morningPvSurplusP50Kwh: morning.p50,
    longGapAhead: longGapAhead(window, nextFullCheapWindow(periodIdAt, window.endMs, 'overnight')),
    prePeakPvSurplusP10Kwh: pessimisticPrePeakSurplus({ hours: prob.map((x) => ({ ts: x.ts, p10W: x.p10W, loadW: x.loadW })), windowEndMs: window.endMs, isOnPeakAt }).kwh,
    minBuyKwh: 1, buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true,
    ...over,
  };
}

/** The named nights, each in the shapes its own tests used. */
function namedCases(): IdentityCase[] {
  return [
    { label: '2026-10-12 cost', deps: case1012({}) },
    { label: '2026-10-12 cost at 74%', deps: case1012({ socNowPct: 74 }) },
    { label: '2026-10-12 resilience', deps: case1012({ objectiveMode: 'resilience', forceChargeEligible: false }) },
    { label: '2026-10-12 no EV', deps: case1012({ ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 } }) },
    { label: '2026-10-12 mid-window 02:55', deps: case1012({ nowMs: phx(2026, 10, 13, 2, 55), socNowPct: 47 }) },
    { label: '2026-09-29 sunny 60%', deps: case0929({}, 60, 1) },
    { label: '2026-09-29 sunny 74%', deps: case0929({}, 74, 1) },
    { label: '2026-09-29 cloudy 60%', deps: case0929({}, 60, 0.4) },
    { label: '2026-09-29 resilience 30%', deps: case0929({ objectiveMode: 'resilience', forceChargeEligible: false }, 30, 1) },
  ];
}

/** Every case, in a fixed order. */
export function legacyIdentityCases(): IdentityCase[] {
  return [...namedCases(), ...yearCases()];
}

/** The plan as a digest: its JSON (what is persisted and served) and its own key list (so a
 *  field added with an undefined value, which JSON drops, still shows). */
export function planDigest(plan: NightChargePlan): string {
  return createHash('sha256').update(JSON.stringify([Object.keys(plan), plan])).digest('hex').slice(0, 20);
}

/** The digest of every case's plan, by label. */
export function legacyIdentityDigests(depsOf: (c: IdentityCase) => NightChargeInputDeps = (c) => c.deps): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of legacyIdentityCases()) out[c.label] = planDigest(computeNightChargePlan(buildNightChargeInputs(depsOf(c))));
  return out;
}
