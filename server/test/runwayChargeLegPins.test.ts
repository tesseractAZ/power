import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.194.0 — the charge leg's source pins. Every walk that steps a pool hour by hour stores a PV
 * surplus through chargeLegStep (physics/chargeLeg.ts); runwayChargeLeg.test.ts pins what each one
 * computes, this file that each one still calls the step, so a refactor that drops it from a walk
 * no fixture covers is caught too.
 * ═════════════════════════════════════════════════════════════════════════ */

test('★★★ source pins: every walk steps the pool through chargeLegStep; the planner still never reads the runway basis', () => {
  const src = (p: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src', p), 'utf8');
  /** A top-level declaration's text: from `head` to the next top-level declaration. */
  const body = (file: string, head: string): string => {
    const s = src(file);
    const start = s.indexOf(head);
    assert.ok(start >= 0, `${head} not found in ${file}`);
    const ends = ['\nexport ', '\nfunction ', '\nasync function ', '\nconst ', '\nlet ', '\n/**']
      .map((m) => s.indexOf(m, start + head.length)).filter((i) => i > start);
    return s.slice(start, Math.min(...ends));
  };
  const an = 'analytics.ts', nca = 'nightChargeAdvisor.ts';
  const pins: Array<[string, string, RegExp]> = [
    [an, 'export function computeRunway(', /const delta = chargeLegStep\(pvKwh - runwayDrainW\(loadKwhPerHour \* 1000, basis\.overheadW\) \/ 1000, RUNWAY_CHARGE_EFFICIENCY\);/],
    // v1.195.0 — the day walk's step is one closure (stepSocWh) for the alarm walk and the restored
    // display walk: the charge leg is pinned inside it, and both walks are pinned to call it.
    [an, 'async function computeDayForecastUncached(', /const stepSocWh = \(soc: number, full: number, pvW: number, loadW: number\): number =>\s+Math\.max\(0, Math\.min\(full, soc \+ chargeLegStep\(pvW - runwayDrainW\(loadW, poolBasis\.overheadW\), RUNWAY_CHARGE_EFFICIENCY\)\)\);/],
    [an, 'async function computeDayForecastUncached(', /socWh = stepSocWh\(socWh, fullWh, pvAlarm, load\);/],
    [an, 'async function computeDayForecastUncached(', /socWhDisplay = stepSocWh\(socWhDisplay, fullWh, restoredPvW, loadWs\[k\]\);/],
    [an, 'export async function computeMultiDayForecast(', /socWh \+ chargeLegStep\(pv - runwayDrainW\(load, poolBasis\.overheadW\), RUNWAY_CHARGE_EFFICIENCY\)/],
    [an, 'export async function computeProbabilisticForecast(', /chargeLegStep\(dP50Kwh \+ z \* sigmaNetKwh, RUNWAY_CHARGE_EFFICIENCY\)/],
    [an, 'export async function computeProbabilisticForecast(', /const netKwh = \(pvW: number, loadW: number\): number => chargeLegStep\(rawNetKwh\(pvW, loadW\), RUNWAY_CHARGE_EFFICIENCY\);/],
    [nca, 'function simulate(', /packWh \+ chargeLegStep\(h\.pvP10W - h\.loadP90W \/ dischargeEff, chargeEff\)/],
    [nca, 'export function expectedCarryKwh(', /pack \+ chargeLegStep\(\(w \* \(pv - Math\.max\(0, h\.loadP50W!\) \/ o\.dischargeEff\)\) \/ 1000, o\.legEff\)/],
    [nca, 'export function expectedPvChargeWalk(', /chargeLegStep\(\(pvW \/ 1000\) \* dtH, o\.legEff\)/],
    [nca, 'export function expectedForceChargeStart(', /pack \+ chargeLegStep\(\(\(pv - loadW \/ o\.dischargeEff\) \/ 1000\) \* \(EXPECTED_JIT_STEP_MS \/ HOUR_MS\), o\.legEff\)/],
    ['middayShadow.ts', 'export function heldImportEstimate(', /const net = chargeLegStep\(\(w \* \(Math\.max\(0, h\.pvP50W\) - Math\.max\(0, h\.loadP50W\) \/ o\.dischargeEff\)\) \/ 1000, o\.legEff\);/],
  ];
  for (const [file, head, re] of pins) assert.match(body(file, head), re, `${file} ${head}`);
  // The with-buy window walk is a closure inside computeNightChargePlan.
  const s = src(nca);
  const w0 = s.indexOf('  const packAtWindowEndWith = (lift: number): number => {');
  const withBuy = s.slice(w0, s.indexOf('\n  };\n', w0));
  assert.ok(w0 > 0 && withBuy.length > 200);
  assert.match(withBuy, /pack \+ gainKwh \+ chargeLegStep\(pvKwh - drainKwh, legEff\)/);
  // Every simulate() call passes the charge leg (legEff) after the discharge leg.
  const calls = [...s.matchAll(/(?<!function )\bsimulate\((?!\))([^;]*?)\)(?:\.\w+)?;/gs)].map((m) => m[1]);
  assert.ok(calls.length >= 5, `${calls.length} simulate calls`);
  for (const c of calls) assert.match(c, /dischargeEff, legEff, /, `simulate(${c.trim()})`);
  // One charge leg on the alarm path: the constant, not a literal.
  assert.match(src(an), /^export const RUNWAY_CHARGE_EFFICIENCY = Math\.sqrt\(DISPATCH_ROUND_TRIP_EFFICIENCY\);$/m);
  // The planner takes the step from the neutral module, never the runway's basis.
  assert.match(s, /^import \{ chargeLegStep \} from '\.\/physics\/chargeLeg\.js';$/m);
  assert.ok(!/poolEnergyBasis|runwayDrainW|RUNWAY_CHARGE_EFFICIENCY/.test(s), 'the planner reads its injected legEff, not the runway\'s constant');
  assert.doesNotMatch(src('physics/chargeLeg.ts'), /^import /m, 'the step imports nothing');
  // The option's own descriptions name the alarm path it now reaches: DISPATCH_ROUND_TRIP_EFFICIENCY=1
  // puts the runway's surplus credit back at unity, so it is not a cost-only knob.
  const doc = (file: string, decl: string): string => {
    const s2 = src(file);
    const at = s2.indexOf(decl);
    assert.ok(at > 0, `${decl} not found in ${file}`);
    return s2.slice(s2.lastIndexOf('/*', at), at);
  };
  for (const [file, decl] of [
    ['limits.ts', 'export const DISPATCH_ROUND_TRIP_EFFICIENCY = '],
    [an, 'export { DISPATCH_ROUND_TRIP_EFFICIENCY };'],
  ] as const) {
    const d = doc(file, decl);
    assert.match(d, /RUNWAY_CHARGE_EFFICIENCY/, `${file}: the declaration's comment names the runway's charge leg`);
    assert.doesNotMatch(d, /Advisory-only\.(?! until)/, `${file}: not described as advisory only`);
  }
});

test('★ the buy_err_kwh notes name the surplus-hour LOAD miss; the round-trip notes say what 1 does to the plans', () => {
  // A surplus hour's whole net (pv − load/dischargeEff) is stored at legEff, so a load miss there moves
  // against the ledger's fixed 1/legEff conversion by the same 1/legEff as a PV miss
  // (runwayChargeLeg.test.ts works it). The notes once said load misses convert as before.
  const here = dirname(fileURLToPath(import.meta.url));
  const gate = readFileSync(resolve(here, '../src/nightChargeGate.ts'), 'utf8');
  const at = gate.indexOf('v1.194.0 — what the charge leg does to `buy_err_kwh`.');
  assert.ok(at > 0, 'the gate\'s v1.194.0 buy_err_kwh note');
  // The comment's text with its line breaks and leading asterisks folded to single spaces.
  const note = gate.slice(at, gate.indexOf('export const CURRENT_ALGO_VERSION', at)).replace(/\s*\n\s*\*\s*/g, ' ');
  const ch152 = readFileSync(resolve(here, '../../docs/reference/15-2-night-charge-writes.md'), 'utf8');
  const row = ch152.split('\n').find((l) => l.startsWith('| `buy_err_kwh` basis |'));
  assert.ok(row, 'chapter 15-2\'s buy_err_kwh basis row');
  for (const [where, text] of [['nightChargeGate.ts', note], ['chapter 15-2', row]] as const) {
    assert.doesNotMatch(text, /load misses convert as before/, `${where}: a surplus-hour load miss does not convert as before`);
    assert.match(text, /solar or load/, `${where}: both kinds of surplus-hour miss named`);
    assert.match(text, /1\.4 %/, `${where}: the surplus-hour load miss's figure`);
    assert.match(text, /Only misses in deficit hours read as before/, `${where}: the hours that are unchanged`);
  }
  // DISPATCH_ROUND_TRIP_EFFICIENCY = 1 restores the runway's unity credit only; the planner's and the
  // dispatch plan's grid charge become lossless too (runwayChargeLeg.test.ts: 0.80 kWh below).
  const ch5 = readFileSync(resolve(here, '../../docs/reference/05-runway-and-soc-alarms.md'), 'utf8');
  assert.doesNotMatch(ch5, /1 is the walk before v1\.194\.0/);
  assert.match(ch5, /Setting it to 1 puts the runway's and the projections' surplus credit back at unity, as before v1\.194\.0; it also makes the dispatch plan's and the night-charge planner's charging lossless, so they buy less than before\./);
});
