/**
 * v1.199.0 — the year of legacyIdentityFixtures.ts cases planned with the house pool's measured
 * capacity scale passed, as index.ts passes it on the reference fleet (0.944, 'measured'), reduced to
 * the figures the measured cushion line moves. measuredCushionLine.figures.json holds them as the
 * planner produced them when the change was made; measuredCushionLine.test.ts holds every later
 * planner to them, number for number (legacyIdentity.golden.json holds the same cases on the
 * nameplate line, which an absent scale reproduces byte for byte).
 *
 * Regenerate only for a deliberate, reviewed change to overnight sizing, say so in the commit, and
 * explain every case that moved:
 *
 *   cd server && node --import tsx test/fixtures/measuredCushionLineFigures.ts --write "<generatedAt>"
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNightChargeInputs, computeNightChargePlan, type NightChargePlan, type CushionPoolScale } from '../../src/nightChargeAdvisor.js';
import { clampReserveTarget } from '../../src/nightChargeActuator.js';
import { legacyIdentityCases } from './legacyIdentityFixtures.js';

/** The reference fleet's measured capacity scale (849,556 / 900,000 mAh, 2026-10-01). */
export const MEASURED_SCALE: CushionPoolScale = Object.freeze({ scale: 0.944, basis: 'measured' }) as CushionPoolScale;

export const FIGURE_FIELDS = [
  'chargeTonight', 'cushionLineSocPct', 'setpointSocPct', 'writtenPct', 'buyKwh', 'requiredExtraKwh',
  'expectedBuyKwh', 'expectedWriteLevelPct', 'costCeilingSocPct', 'cushionShortfall',
] as const;
export type Figures = Array<number | null>;

/** A plan's figures, in FIGURE_FIELDS order: booleans as 1/0, the written reserve as the actuator
 *  writes it (clampReserveTarget of the setpoint), absent as null. */
export function figuresOf(p: NightChargePlan): Figures {
  return [
    p.chargeTonight ? 1 : 0,
    p.cushionLineSocPct ?? null,
    p.setpointSocPct ?? null,
    p.setpointSocPct != null ? clampReserveTarget(p.setpointSocPct) : null,
    p.buyKwh ?? null,
    p.requiredExtraKwh ?? null,
    p.expectedBuyKwh ?? null,
    p.expectedWriteLevelPct ?? null,
    p.costCeilingSocPct ?? null,
    p.cushionShortfall ? 1 : 0,
  ];
}

/** Every case's figures at MEASURED_SCALE, by label, in the fixtures' order. */
export function measuredFigures(scale: CushionPoolScale = MEASURED_SCALE): Record<string, Figures> {
  const out: Record<string, Figures> = {};
  for (const c of legacyIdentityCases()) {
    out[c.label] = figuresOf(computeNightChargePlan(buildNightChargeInputs({ ...c.deps, cushionPoolScale: scale })));
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIGURES_PATH = resolve(HERE, 'measuredCushionLine.figures.json');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--write');
  if (at < 0 || !process.argv[at + 1]) {
    console.error('usage: node --import tsx test/fixtures/measuredCushionLineFigures.ts --write "<generatedAt>"');
    process.exit(2);
  }
  const figures = measuredFigures();
  const about = 'Each legacyIdentityFixtures.ts case planned with the house pool\'s measured capacity scale passed (cushionPoolScale { scale: 0.944, basis: \'measured\' }, the reference fleet), as figures: '
    + `[${FIGURE_FIELDS.join(', ')}] (booleans 1/0; writtenPct = clampReserveTarget(setpointSocPct)). measuredCushionLine.test.ts holds the planner to them number for number. `
    + 'Regenerate only for a deliberate, reviewed change to overnight sizing (measuredCushionLineFigures.ts), and say so in the commit.';
  // One case per line, as legacyIdentity.v1192.figures.json.
  const lines = Object.entries(figures).map(([l, f]) => `  ${JSON.stringify(l)}: ${JSON.stringify(f).replace(/,/g, ', ')}`);
  const text = `{\n "_about": ${JSON.stringify(about)},\n "generatedAt": ${JSON.stringify(process.argv[at + 1])},\n`
    + ` "scale": ${JSON.stringify(MEASURED_SCALE)},\n "fields": ${JSON.stringify(FIGURE_FIELDS)},\n "figures": {\n${lines.join(',\n')}\n }\n}\n`;
  JSON.parse(text); // well-formed, or nothing is written
  writeFileSync(FIGURES_PATH, text);
  console.log(`${Object.keys(figures).length} cases → ${FIGURES_PATH}`);
}
