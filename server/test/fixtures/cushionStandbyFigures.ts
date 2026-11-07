/**
 * v1.201.0 — the year of legacyIdentityFixtures.ts cases planned with the Cores' standby counted in the
 * islanded-outage cushion (cushionStandbyW), as index.ts passes it, reduced to the figures the standby moves
 * (measuredCushionLineFigures.ts's FIGURE_FIELDS). cushionStandby.figures.json holds them as the planner
 * produced them when the change was made; cushionStandby.test.ts holds every later planner to them, number
 * for number. Three sets:
 *  - 'm270'   — the reference fleet: the measured scale (0.944) and the runway's 270 W figure;
 *  - 'np270'  — the live basis while no pack ratio has been measured (no scale) and the same 270 W;
 *  - 'm333.3' — the measured scale and a figure whose energy is not a whole hundredth of a kWh (the overhead
 *    options accept decimals), so the cushion's rounding of the sum is visible in the figures.
 *
 * Regenerate only for a deliberate, reviewed change to overnight sizing, say so in the commit, and explain
 * every case that moved:
 *
 *   cd server && node --import tsx test/fixtures/cushionStandbyFigures.ts --write "<generatedAt>"
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNightChargeInputs, computeNightChargePlan, type CushionPoolScale } from '../../src/nightChargeAdvisor.js';
import { legacyIdentityCases } from './legacyIdentityFixtures.js';
import { FIGURE_FIELDS, figuresOf, MEASURED_SCALE, type Figures } from './measuredCushionLineFigures.js';

/** The figure sets: the scale passed (null: none) and the standby figure passed, W. */
export const STANDBY_SETS: Readonly<Record<string, { scale: CushionPoolScale | null; w: number }>> = Object.freeze({
  m270: { scale: MEASURED_SCALE, w: 270 },
  np270: { scale: null, w: 270 },
  'm333.3': { scale: MEASURED_SCALE, w: 333.3 },
});

/** Every case's figures for one set, by label, in the fixtures' order. */
export function standbyFigures(set: { scale: CushionPoolScale | null; w: number }): Record<string, Figures> {
  const out: Record<string, Figures> = {};
  for (const c of legacyIdentityCases()) {
    const deps = { ...c.deps, ...(set.scale != null ? { cushionPoolScale: set.scale } : {}), cushionStandbyW: set.w };
    out[c.label] = figuresOf(computeNightChargePlan(buildNightChargeInputs(deps)));
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const STANDBY_FIGURES_PATH = resolve(HERE, 'cushionStandby.figures.json');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--write');
  if (at < 0 || !process.argv[at + 1]) {
    console.error('usage: node --import tsx test/fixtures/cushionStandbyFigures.ts --write "<generatedAt>"');
    process.exit(2);
  }
  const about = 'Each legacyIdentityFixtures.ts case planned with the Cores\' standby counted in the islanded-outage cushion (cushionStandbyW), per set: '
    + 'm270 = cushionPoolScale { scale: 0.944, basis: \'measured\' } and 270 W; np270 = no scale and 270 W; m333.3 = the measured scale and 333.3 W. '
    + `Figures: [${FIGURE_FIELDS.join(', ')}] (booleans 1/0; writtenPct = clampReserveTarget(setpointSocPct)). cushionStandby.test.ts holds the planner to them number for number. `
    + 'Regenerate only for a deliberate, reviewed change to overnight sizing (cushionStandbyFigures.ts), and say so in the commit.';
  const sets = Object.entries(STANDBY_SETS).map(([name, set]) => {
    const lines = Object.entries(standbyFigures(set)).map(([l, f]) => `   ${JSON.stringify(l)}: ${JSON.stringify(f).replace(/,/g, ', ')}`);
    return `  ${JSON.stringify(name)}: {\n   "scale": ${JSON.stringify(set.scale)}, "w": ${JSON.stringify(set.w)},\n   "figures": {\n${lines.map((x) => ` ${x}`).join(',\n')}\n   }\n  }`;
  });
  const text = `{\n "_about": ${JSON.stringify(about)},\n "generatedAt": ${JSON.stringify(process.argv[at + 1])},\n`
    + ` "fields": ${JSON.stringify(FIGURE_FIELDS)},\n "sets": {\n${sets.join(',\n')}\n }\n}\n`;
  JSON.parse(text); // well-formed, or nothing is written
  writeFileSync(STANDBY_FIGURES_PATH, text);
  console.log(`${Object.keys(STANDBY_SETS).length} sets × ${legacyIdentityCases().length} cases → ${STANDBY_FIGURES_PATH}`);
}
