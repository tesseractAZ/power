#!/usr/bin/env node
/**
 * mutate-v1187-1f.mjs — committed harness for v1.187.1 (planner morning surplus, cost ceiling):
 * the cost ceiling's morning surplus on a DE-BIASED load.
 *
 * The cost ceiling leaves room for Σ max(0, P50 PV − forecast load) over window close → +14 h.
 * The forecast load ran above the measured load on every ledger night of 2026-09-22..28
 * (load_err_frac −0.26 to −0.43), so the 09-29 ceiling of 77.7% bought ~18.9 kWh that the next
 * day's sun would have supplied: the pool was full by 13:00 on 09-30 and ~9-12 kWh of PV was
 * curtailed. The surplus the ceiling uses is now computed on the load scaled by the ledger's
 * median realized/forecast ratio (costSurplusLoadFactor: shrink-only, 1 under five nights,
 * ramped in to ten, bounded at 0.6), each hour floored at the least the house drew in that
 * clock hour over the trailing week (measuredHourlyLoadFloorW, costSurplusLoadW; the EV block
 * kept whole), and used only where it is wider than the raw surplus and never past the
 * resilience lift (debiasedCostSurplusKwh). Cost mode only; long-gap nights untouched.
 * Mutants i-xxxvii.
 *
 *   node scripts/mutate-v1187-1f.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NCA = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IDX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/costCeilingLoadDebias.test.ts',
  'test/longGapCeiling.test.ts',
  'test/thursdayHeadroom.test.ts',
  'test/costObjective.test.ts',
  'test/costModeAskedFirst.test.ts',
];

const MUTANTS = [
  /* ── the factor ───────────────────────────────────────────────────────── */
  {
    id: 'i. ★★★ a handful of nights is trusted',
    file: NCA,
    find: "  if (n < COST_SURPLUS_LOAD_MIN_SAMPLES) return { factor: 1, basis: 'default', samples: n, medianRatio: null };",
    to: "  if (n < 1) return { factor: 1, basis: 'default', samples: n, medianRatio: null }; /* MUTANT */",
    why: 'Two odd nights after a restart of the ledger move the ceiling: a first-week guess sizes the buy.',
  },
  {
    id: 'ii. ★★★ the factor may scale the load UP',
    file: NCA,
    find: '  const factor = Math.min(1, Math.max(COST_SURPLUS_LOAD_FACTOR_MIN, 1 + weight * (median - 1)));',
    to: '  const factor = Math.max(COST_SURPLUS_LOAD_FACTOR_MIN, 1 + weight * (median - 1)); /* MUTANT */',
    why: 'A ledger whose load ran high reports a factor above 1: the change is no longer shrink-only.',
  },
  {
    id: 'iii. ★★ the factor is unbounded below',
    file: NCA,
    find: '  const factor = Math.min(1, Math.max(COST_SURPLUS_LOAD_FACTOR_MIN, 1 + weight * (median - 1)));',
    to: '  const factor = Math.min(1, 1 + weight * (median - 1)); /* MUTANT */',
    why: 'A week of telemetry gaps (actual load under-counted) drives the load toward zero and the ceiling with it.',
  },
  {
    id: 'iv. ★★★ the correction is whole from the fifth night',
    file: NCA,
    find: '  const weight = Math.min(1, n / COST_SURPLUS_LOAD_FULL_SAMPLES);',
    to: '  const weight = 1; /* MUTANT */',
    why: 'No shrinkage toward the forecast while samples are few.',
  },
  {
    id: 'v. ★★ the median of an even count is its upper middle',
    file: NCA,
    find: '  const median = n % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;',
    to: '  const median = ratios[mid]; /* MUTANT */',
    why: 'An even sample leans to the higher ratio: a biased median.',
  },
  {
    id: 'vi. ★★ an impossible ratio (actual ≤ 0) is a sample',
    file: NCA,
    find: '    .filter((r) => r > 0)\n',
    to: '    /* MUTANT */\n',
    why: 'A night whose actual load integrated to nothing (a dark panel) counts as a 100% over-forecast.',
  },
  /* ── the physical floor ───────────────────────────────────────────────── */
  {
    id: 'vii. ★★★ an hour seen on one day has a floor',
    file: NCA,
    find: '  return byHour.map((v) => (v.length >= COST_SURPLUS_FLOOR_MIN_DAYS ? Math.min(...v) : null));',
    to: '  return byHour.map((v) => (v.length >= 1 ? Math.min(...v) : null)); /* MUTANT */',
    why: 'One quiet morning after a restart becomes the floor the whole factor may scale down to.',
  },
  {
    id: 'viii. ★★★ the floor is the week\'s HIGHEST hour',
    file: NCA,
    find: '  return byHour.map((v) => (v.length >= COST_SURPLUS_FLOOR_MIN_DAYS ? Math.min(...v) : null));',
    to: '  return byHour.map((v) => (v.length >= COST_SURPLUS_FLOOR_MIN_DAYS ? Math.max(...v) : null)); /* MUTANT */',
    why: 'Not a floor: an EV afternoon restores the forecast every hour and nothing is de-biased.',
  },
  {
    id: 'ix. ★★ a negative reading is a floor',
    file: NCA,
    find: "    if (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0) continue;",
    to: "    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) continue; /* MUTANT */",
    why: 'A sign-flipped reading lowers the floor below anything the house drew.',
  },
  {
    id: 'x. ★★★ the hour ignores its floor',
    file: NCA,
    find: '  return Math.max(baseW * factor, Math.min(Math.max(0, floorW), baseW)) + evW;',
    to: '  return baseW * factor + evW; /* MUTANT */',
    why: 'The de-biased load drops below what the house drew in that hour every day this week.',
  },
  {
    id: 'xi. ★★★ a floor above the forecast raises the load past it',
    file: NCA,
    find: '  return Math.max(baseW * factor, Math.min(Math.max(0, floorW), baseW)) + evW;',
    to: '  return Math.max(baseW * factor, Math.max(0, floorW)) + evW; /* MUTANT */',
    why: 'A heavy week lifts the load above the forecast: the surplus shrinks and the ceiling RISES past today\'s.',
  },
  {
    id: 'xii. ★★★ the EV block is de-biased with the house',
    file: NCA,
    find: '  const evW = o.evW != null && Number.isFinite(o.evW) && o.evW > 0 ? Math.min(o.evW, Math.max(0, loadW)) : 0;',
    to: '  const evW = 0; /* MUTANT */',
    why: 'A predicted morning session is scaled away: the surplus counts sun the car will take.',
  },
  {
    id: 'xiii. ★★★ an hour with no measured floor is de-biased anyway',
    file: NCA,
    find: '  if (!Number.isFinite(loadW) || !(factor < 1) || floorW == null || !Number.isFinite(floorW)) return loadW;',
    to: '  if (!Number.isFinite(loadW) || !(factor < 1)) return loadW; /* MUTANT */',
    why: 'A failed history read de-biases every hour with no physical floor (or NaNs the surplus).',
  },
  {
    id: 'xiv. ★★★ a factor of 1 or more still scales',
    file: NCA,
    find: '  if (!Number.isFinite(loadW) || !(factor < 1) || floorW == null || !Number.isFinite(floorW)) return loadW;',
    to: '  if (!Number.isFinite(loadW) || floorW == null || !Number.isFinite(floorW)) return loadW; /* MUTANT */',
    why: 'A factor above 1 raises the load: the change is no longer shrink-only at the hour.',
  },
  /* ── the morning surplus ──────────────────────────────────────────────── */
  {
    id: 'xv. ★★★ a P50 with a missing hour is reported',
    file: NCA,
    find: '  return { p50Kwh: p50Complete ? round2(p50Kwh) : null, p90Kwh: round2(p90Kwh) };',
    to: '  return { p50Kwh: round2(p50Kwh), p90Kwh: round2(p90Kwh) }; /* MUTANT */',
    why: 'A partial median (the missing hour counted as 0 surplus) stands where the raw P50 is null.',
  },
  {
    id: 'xvi. ★★ the P90 stand-in keeps the forecast load',
    file: NCA,
    find: '    p90Kwh += Math.max(0, h.p90W - loadW) / 1000;',
    to: '    p90Kwh += Math.max(0, h.p90W - h.loadW) / 1000; /* MUTANT */',
    why: 'A night whose P50 is unknown keeps the biased ceiling.',
  },
  /* ── the headroom the ceiling uses ────────────────────────────────────── */
  {
    id: 'xvii. ★★★ a NARROWER de-biased surplus is used',
    file: NCA,
    find: '  if (debiasedKwh == null || !Number.isFinite(debiasedKwh) || !(debiasedKwh > rawKwh)) return rawKwh;',
    to: '  if (debiasedKwh == null || !Number.isFinite(debiasedKwh)) return rawKwh; /* MUTANT */',
    why: 'A de-biased figure below the raw one RAISES the ceiling and the buy past today\'s.',
  },
  {
    id: 'xviii. ★★★ no resilience bound',
    file: NCA,
    find: '  return Math.min(debiasedKwh, Math.max(rawKwh, fullKwh - resilienceTargetKwh));',
    to: '  return debiasedKwh; /* MUTANT */',
    why: 'The ceiling falls below the resilience lift: the force-charge stops short of what the cushion asked.',
  },
  {
    id: 'xix. ★★★ the bound overrides a raw ceiling already below the resilience target',
    file: NCA,
    find: '  return Math.min(debiasedKwh, Math.max(rawKwh, fullKwh - resilienceTargetKwh));',
    to: '  return Math.min(debiasedKwh, fullKwh - resilienceTargetKwh); /* MUTANT */',
    why: 'The headroom shrinks below the raw figure: the ceiling RISES past today\'s.',
  },
  {
    id: 'xx. ★★ an unknown raw surplus takes the de-biased one',
    file: NCA,
    find: '  if (rawKwh == null || !Number.isFinite(rawKwh)) return rawKwh;',
    to: '  if (rawKwh == null || !Number.isFinite(rawKwh)) return debiasedKwh ?? null; /* MUTANT */',
    why: 'Not today\'s behaviour when the raw figure is unknown (the P90 stand-in / max-SoC cap decide).',
  },
  /* ── the planner's wiring ─────────────────────────────────────────────── */
  {
    id: 'xxi. ★★★ the planner never reads the de-biased surplus',
    file: NCA,
    find: '  const costLoad = inputs.costSurplusLoad ?? null;',
    to: '  const costLoad = null as CostSurplusLoad | null; /* MUTANT */',
    why: 'The 09-29 ceiling stays 77.7%: the curtailed afternoon, rebuilt.',
  },
  {
    id: 'xxii. ★★★ the P50 basis reads the de-biased P90',
    file: NCA,
    find: "    debiasedKwh: costSurplusBasis === 'p50' ? costLoad?.p50Kwh : costSurplusBasis === 'p90' ? costLoad?.p90Kwh : null,",
    to: "    debiasedKwh: costSurplusBasis === 'p50' ? costLoad?.p90Kwh : costSurplusBasis === 'p90' ? costLoad?.p90Kwh : null, /* MUTANT */",
    why: 'The median ceiling leaves room for the best-case sun.',
  },
  {
    id: 'xxiii. ★★★ the P90 stand-in is not de-biased',
    file: NCA,
    find: "    debiasedKwh: costSurplusBasis === 'p50' ? costLoad?.p50Kwh : costSurplusBasis === 'p90' ? costLoad?.p90Kwh : null,",
    to: "    debiasedKwh: costSurplusBasis === 'p50' ? costLoad?.p50Kwh : null, /* MUTANT */",
    why: 'A night whose P50 is unknown keeps the biased stand-in.',
  },
  {
    id: 'xxiv. ★★★ the bound is the no-buy pack on an economic night',
    file: NCA,
    find: '    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh : 0,',
    to: '    resilienceTargetKwh: targetPackKwh, /* MUTANT */',
    why: 'A pack already high stops the de-bias: the ceiling reads the raw figure on a hold.',
  },
  {
    id: 'xxv. ★★★ the bound is off',
    file: NCA,
    find: '    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh : 0,',
    to: '    resilienceTargetKwh: 0, /* MUTANT */',
    why: 'A night that needs a resilience buy gets a ceiling below it.',
  },
  {
    id: 'xxvi. ★★★ the cost target is sized on the raw surplus',
    file: NCA,
    find: '      morningPvSurplusKwh: costHeadroomKwh,\n',
    to: '      morningPvSurplusKwh: costSurplusKwh, /* MUTANT */\n',
    why: 'The ceiling is reported lower but the buy is sized to the old one.',
  },
  {
    id: 'xxvii. ★★★ the force-charge ceiling is the raw one',
    file: NCA,
    find: '        fullKwh, morningPvSurplusKwh: costHeadroomKwh, maxSocPct: inputs.costMaxSocPct ?? DEFAULT_COST_MAX_SOC_PCT,',
    to: '        fullKwh, morningPvSurplusKwh: costSurplusKwh, maxSocPct: inputs.costMaxSocPct ?? DEFAULT_COST_MAX_SOC_PCT, /* MUTANT */',
    why: 'costCeilingSocPct — where the force-charge stops — keeps the biased 77.7%.',
  },
  {
    id: 'xxviii. ★★ the plan reports the raw surplus as the one used',
    file: NCA,
    find: '    costCeilingSurplusKwh: costMode ? (costHeadroomKwh != null ? round2(costHeadroomKwh) : null) : undefined,',
    to: '    costCeilingSurplusKwh: costMode ? (costSurplusKwh != null ? round2(costSurplusKwh) : null) : undefined, /* MUTANT */',
    why: 'The ledger and status read a headroom the ceiling did not use.',
  },
  {
    id: 'xxix. ★★ buildNightChargeInputs drops it',
    file: NCA,
    find: '    // v1.187.1 — forwarded verbatim; see the destructure note above.\n    costSurplusLoad,\n',
    to: '    /* MUTANT */\n',
    why: 'The v1.125.0 trap: computed in index.ts, never reaches the planner.',
  },
  {
    id: 'xxx. ★★ a cost-mode hold drops the headroom fields',
    file: NCA,
    find: '        costCeilingSurplusBasis: costSurplusBasis,\n        ...costHeadroomFields,\n',
    to: '        costCeilingSurplusBasis: costSurplusBasis, /* MUTANT */\n',
    why: 'A hold night cannot say which load its ceiling was measured on.',
  },
  {
    id: 'xxxi. ★★ a long-gap night reports a de-bias it did not use',
    file: NCA,
    find: '    costSurplusLoadFactor: costLoad != null && !longGap ? costLoad.factor : null,',
    to: '    costSurplusLoadFactor: costLoad != null ? costLoad.factor : null, /* MUTANT */',
    why: 'The status claims a de-biased load on a night sized on its own P10 surplus.',
  },
  {
    id: 'xxxii. ★ the rationale names a de-bias that changed nothing',
    file: NCA,
    find: '    && costHeadroomKwh > costSurplusKwh + 0.005\n',
    to: '    /* MUTANT */\n',
    why: 'Every cost night reads "×1 of its forecast": a few-sample night is no longer today\'s night.',
  },
  /* ── index.ts (no seam a unit test can drive: source pins) ────────────── */
  {
    id: 'xxxiii. ★★★ index.ts never passes the de-biased surplus',
    file: IDX,
    find: '    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, prePeakPvSurplusP10Kwh,\n    costSurplusLoad,\n',
    to: '    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, prePeakPvSurplusP10Kwh, /* MUTANT */\n',
    why: 'The live planner keeps the biased ceiling while every unit test passes.',
  },
  {
    id: 'xxxiv. ★★★ index.ts drops the EV block from the hours',
    file: IDX,
    find: '      morningHours.push({ ts: pb.ts, p50W: pb.p50W, p90W: pb.p90W, loadW: fh.forecastLoadW, evW: fh.predictedEvLoadW ?? 0 });',
    to: '      morningHours.push({ ts: pb.ts, p50W: pb.p50W, p90W: pb.p90W, loadW: fh.forecastLoadW, evW: 0 }); /* MUTANT */',
    why: 'A predicted morning session is de-biased with the house.',
  },
  {
    id: 'xxxv. ★★★ index.ts attaches no floor',
    file: IDX,
    find: '      morningHours.map((h) => ({ ...h, floorW: floorByHour ? floorByHour[localParts(h.ts, tz).hour] : null })),',
    to: '      morningHours.map((h) => ({ ...h, floorW: null })), /* MUTANT */',
    why: 'The de-bias never applies live (every hour lacks a floor).',
  },
  {
    id: 'xxxvi. ★★ index.ts reads the floor from the wrong span',
    file: IDX,
    find: "      .query(shp2.sn, 'panel_load', nowMs - COST_SURPLUS_FLOOR_DAYS * 24 * HOUR_MS, nowMs, 3600)",
    to: "      .query(shp2.sn, 'panel_load', nowMs - 24 * HOUR_MS, nowMs, 3600) /* MUTANT */",
    why: 'One day of history: no hour reaches four days, so no floor and no de-bias.',
  },
  {
    id: 'xxxvii. ★★ index.ts reads the ledger over its whole life',
    file: IDX,
    find: '    (() => { try { return recorder.readNightLedger(COST_SURPLUS_LOAD_LOOKBACK_DAYS); } catch { return []; } })(),',
    to: '    (() => { try { return recorder.readNightLedger(120); } catch { return []; } })(), /* MUTANT */',
    why: 'Summer nights set the autumn factor: the bias the load curve has lost is still corrected.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-v1187-1f: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
