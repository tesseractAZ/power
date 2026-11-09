/**
 * v1.203.0 — the year of legacyIdentityFixtures.ts cases WITH THE CORES DARK (cushionOnlyFigures.json): what the cushion-only plan
 * writes on every case, on each pool basis the planner can be handed while the Cores are dark. cushionOnlyPlan.test.ts holds every
 * later planner to it, token for token.
 *
 * The dark plant (darkDeps): every PV figure 0 (the band's and the rollups' P10 and P50, the surpluses), 0 scored calibration days
 * and a 0% band coverage (index.ts passes both while the Cores are dark), the Cores' 270 W standby, a write mode (both force-charge
 * gates live), the fallback eligible and the capacity floor 0.8. Bases: 'held' — the seeded ×0.944 held ratio; 'mk' — ×0.919, the
 * lowest known once the held ratios age out; 'np' — no scale passed, and 'nameplate' — the tracker's nameplate answer: both counted
 * on the capacity floor.
 *
 * Tokens: 'x' refused; '' a hold; else the reserve as written, then 'L' where the line force-charge is armed, and '/stop' where the
 * cost force-charge rides (the long-gap fill in cost mode).
 *
 * Regenerate only for a deliberate, reviewed change, say so in the commit, and explain every case that moved:
 *
 *   cd server && node --import tsx test/fixtures/cushionOnlyFigures.ts --write "<generatedAt>"
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNightChargeInputs, computeNightChargePlan, type NightChargeInputDeps, type NightChargePlan, type CushionPoolScale } from '../../src/nightChargeAdvisor.js';
import { clampReserveTarget, armedForceChargeCeilingPct } from '../../src/nightChargeActuator.js';
import { forceChargeModeOf, forceChargeStopPct } from '../../src/nightForceCharge.js';
import { legacyIdentityCases } from './legacyIdentityFixtures.js';

export type DarkBasis = 'held' | 'mk' | 'np' | 'nameplate';
export const DARK_BASES: Readonly<Record<DarkBasis, CushionPoolScale | null>> = Object.freeze({
  held: { scale: 0.944, basis: 'held' }, mk: { scale: 0.919, basis: 'min-known' }, np: null, nameplate: { scale: 1, basis: 'nameplate' },
});
/** The live cost gate (index.ts forceChargeOn): the cost objective and ARB_COST_MAX_SOC_PCT above the reserve maximum. */
export const costGate = (d: NightChargeInputDeps): boolean => d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50;
/** A case's deps with the Cores dark (see the header), on `basis`. `pv` scales the PV the case had instead of zeroing it (the
 *  fallback must not credit any of it: cushionOnlyPlan.test.ts T3). */
export function darkDeps(d: NightChargeInputDeps, basis: DarkBasis, o: { pv?: number; eligible?: boolean; floor?: number | null } = {}): NightChargeInputDeps {
  const k = o.pv ?? 0;
  const sc = DARK_BASES[basis];
  const zero = (x: number | null | undefined) => (x == null ? x : x * k);
  return {
    ...d,
    bandHours: d.bandHours.map((h) => ({ ...h, pvP10W: h.pvP10W * k, ...(h.pvP50W != null ? { pvP50W: h.pvP50W * k } : {}) })),
    dayRollups: d.dayRollups.map((r) => ({ ...r, hours: r.hours.map((h) => ({ ...h, pvW: h.pvW * k })) })),
    morningPvSurplusP90Kwh: zero(d.morningPvSurplusP90Kwh), morningPvSurplusP50Kwh: zero(d.morningPvSurplusP50Kwh),
    prePeakPvSurplusP10Kwh: zero(d.prePeakPvSurplusP10Kwh),
    calScoredDays: 0, bandCoverageFrac: 0, realizedDailyErrHalfFrac: 0, minCalScoredDays: 14, provisionalMinCalScoredDays: 4,
    cushionStandbyW: 270, ...(sc != null ? { cushionPoolScale: sc } : {}),
    lineForceChargeEligible: true, forceChargeEligible: costGate(d),
    ...(o.eligible === false ? {} : { cushionOnlyEligible: true }),
    ...(o.floor === null ? {} : { cushionOnlyFloorScale: o.floor ?? 0.8 }),
  } as NightChargeInputDeps;
}
export const darkPlan = (d: NightChargeInputDeps, basis: DarkBasis, o: Parameters<typeof darkDeps>[2] = {}): NightChargePlan =>
  computeNightChargePlan(buildNightChargeInputs(darkDeps(d, basis, o)));
/** A plan's token (see the header). */
export function darkToken(p: NightChargePlan, deps: NightChargeInputDeps): string {
  if (!p.basisComplete) return 'x';
  if (!p.chargeTonight || p.setpointSocPct == null) return '';
  const w = String(clampReserveTarget(p.setpointSocPct));
  const cost = deps.forceChargeEligible === true;
  const m = forceChargeModeOf(
    { forceChargeCeilingPct: cost ? armedForceChargeCeilingPct({ costCeilingSocPct: p.costCeilingSocPct ?? null }) : null, forceChargeLineAskPct: p.forceChargeLine?.askPct ?? null } as never,
    { cost, line: true },
  );
  return `${w}${p.forceChargeLine != null ? 'L' : ''}${m?.kind === 'cost' ? `/${forceChargeStopPct(m.targetPct)}` : ''}`;
}
/** Every basis's tokens, in the fixtures' case order, joined by ','. */
export function darkFigures(): Record<DarkBasis, string> {
  const cases = legacyIdentityCases();
  const out = {} as Record<DarkBasis, string>;
  for (const b of Object.keys(DARK_BASES) as DarkBasis[]) {
    out[b] = cases.map((c) => { const deps = darkDeps(c.deps, b); return darkToken(computeNightChargePlan(buildNightChargeInputs(deps)), deps); }).join(',');
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DARK_FIGURES_PATH = resolve(HERE, 'cushionOnlyFigures.json');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--write');
  if (at < 0 || !process.argv[at + 1]) {
    console.error('usage: node --import tsx test/fixtures/cushionOnlyFigures.ts --write "<generatedAt>"');
    process.exit(2);
  }
  const about = 'Each legacyIdentityFixtures.ts case with the Cores dark (cushionOnlyFigures.ts darkDeps), per pool basis (held ×0.944, mk ×0.919, np no scale, nameplate), '
    + 'as tokens joined by ",": "x" refused, "" a hold, the reserve as written, "L" the line force-charge armed, "/stop" the cost force-charge riding. cushionOnlyPlan.test.ts reads it.';
  const doc = { _about: about, generatedAt: process.argv[at + 1], cases: legacyIdentityCases().length, bases: darkFigures() };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  JSON.parse(text);
  writeFileSync(DARK_FIGURES_PATH, text);
  console.log(`${Object.keys(DARK_BASES).length} bases × ${doc.cases} cases → ${DARK_FIGURES_PATH}`);
}
