#!/usr/bin/env node
/**
 * mutate-midday-plan.mjs — R2 (v1.189.0): the mid-day leg sized by the same engine (WindowSpec).
 * T_mid, the reserve a super off-peak leg writes (middayReserveTargetPct); the anchors an armed
 * backup gives the cost leg (max(walk, hold) at its close, the expected carry held until then);
 * C_mid, the cost ceiling under the charge taper (chargeTaper.ts); the PV terms — the grid gain
 * bounded by the packs' acceptance, the P50 PV credited against the expected buy — each a no-op on
 * the overnight leg (legacyIdentity.test.ts holds a year of overnight plans byte-identical).
 *
 *   T_mid           M-i..M-vii
 *   Acceptance      M-viii..M-xiii
 *   PV credit       M-xiv..M-xx
 *   C_mid / taper   M-xxi..M-xxvii
 *   Backup anchors  M-xxviii..M-xxxii
 *   Re-entry hold   M-xxxiii..M-xxxvii (a write under floor + 25 holds; the shadow says why)
 *   Arming          M-xxxviii (a leg arms on the worst case, not on the expected figure alone)
 *
 *   node scripts/mutate-midday-plan.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const CT = resolve(REPO, 'server/src/chargeTaper.ts');
const ACT = resolve(REPO, 'server/src/nightChargeActuator.ts');
const SHADOW = resolve(REPO, 'server/src/middayShadow.ts');
const SUBSET = [
  'test/middayPlan.test.ts',
  'test/chargeTaper.test.ts',
  'test/legacyIdentity.test.ts',
  'test/curtailment.test.ts',
  'test/nightChargeExpectedBuy.test.ts',
  'test/costCeilingLoadDebias.test.ts',
  'test/middayShadow.test.ts',
  'test/chargeCycle.test.ts',
  'test/onPeakGuard.test.ts',
];

const MUTANTS = [
  /* ── T_mid ── */
  {
    id: 'M-i. ★★★ T_mid without R',
    file: NCA,
    find: "  if (o.resiliencePct != null && Number.isFinite(o.resiliencePct)) terms.push(['resilience', Math.ceil(o.resiliencePct)]);",
    to: '  /* MUTANT */',
    why: 'The 10:00 write drops the resilience lift: the evening after the window is held only at the line.',
  },
  {
    id: 'M-ii. ★★ T_mid without the pool term',
    file: NCA,
    find: "  if (o.expectedPoolPct != null && Number.isFinite(o.expectedPoolPct)) terms.push(['pool', Math.floor(o.expectedPoolPct) - 2]);",
    to: '  /* MUTANT */',
    why: 'The house draws the pool down through the cheap window and the force-charge buys it back.',
  },
  {
    id: 'M-iii. ★★ T_mid holds the pool at where the window finds it (no 2-point margin)',
    file: NCA,
    find: "  if (o.expectedPoolPct != null && Number.isFinite(o.expectedPoolPct)) terms.push(['pool', Math.floor(o.expectedPoolPct) - 2]);",
    to: "  if (o.expectedPoolPct != null && Number.isFinite(o.expectedPoolPct)) terms.push(['pool', Math.floor(o.expectedPoolPct)]); /* MUTANT */",
    why: 'A pool a little under its expectation triggers a grid charge at 10:00 that buys nothing.',
  },
  {
    id: "M-iv. ★★ T_mid's floor term is the floor itself",
    file: NCA,
    find: "    ['floor', o.floorPct + 1],",
    to: "    ['floor', o.floorPct], /* MUTANT */",
    why: 'A write equal to the owner floor is no write: nothing marks the leg as raised.',
  },
  {
    id: 'M-v. ★★★ T_mid is not clamped to the write envelope',
    file: NCA,
    find: '  return { pct: clampReserveTarget(best[1]), basis: best[0] };',
    to: '  return { pct: best[1], basis: best[0] }; /* MUTANT */',
    why: 'The plan states a 69% reserve the panel will not take.',
  },
  {
    id: 'M-vi. ★★★ a mid-day leg asks the cost target when floor+cushion holds',
    file: NCA,
    find: '  if (baselineHolds && !midday) {',
    to: '  if (baselineHolds) { /* MUTANT */',
    why: 'The 10:00 reserve carries the cost fill (clamped to 50) instead of the resilience lift.',
  },
  {
    id: 'M-vii. ★★★ the mid-day leg keeps the overnight setpoint rule',
    file: NCA,
    find: '  const middayReserve = midday\n    ? middayReserveTargetPct({',
    to: '  const middayReserve = (false as boolean) /* MUTANT */\n    ? middayReserveTargetPct({',
    why: 'The 10:00 write asks for the arrival (~90%) — clamped to 50 on every leg, whatever the need.',
  },

  /* ── the acceptance bound ── */
  {
    id: 'M-viii. ★★★ the grid gain ignores the sun',
    file: NCA,
    find: '  return pvW > 0 && acceptKw != null ? Math.min(rateGainKw, Math.max(0, acceptKw - pvW / 1000)) : rateGainKw;',
    to: '  return rateGainKw; /* MUTANT */',
    why: 'A noon window is credited the full charge rate on top of the sun: the plan under-states the shortfall.',
  },
  {
    id: 'M-ix. ★★ the acceptance bound forgets the PV it is shared with',
    file: NCA,
    find: '  return pvW > 0 && acceptKw != null ? Math.min(rateGainKw, Math.max(0, acceptKw - pvW / 1000)) : rateGainKw;',
    to: '  return pvW > 0 && acceptKw != null ? Math.min(rateGainKw, acceptKw) : rateGainKw; /* MUTANT */',
    why: 'The packs are credited PV and grid together past what they accept.',
  },
  {
    id: 'M-x. ★★ the default acceptance is the grid-side charge cap',
    file: NCA,
    find: '    ? spec.packAcceptKw : chargeCapKw * legEff;',
    to: '    ? spec.packAcceptKw : chargeCapKw; /* MUTANT */',
    why: 'The default bound is ~7% looser than the charge rate it stands for.',
  },
  {
    id: 'M-xi. ★★★ the sizing walk drops the acceptance bound',
    file: NCA,
    find: 'gainKw: gridGainKw(rateKw * legEff, h.pvP10W, acceptKw) });',
    to: 'gainKw: rateKw * legEff }); /* MUTANT */',
    why: 'The worst case credits grid energy the packs cannot take beside the sun.',
  },
  {
    id: 'M-xii. ★★ the sizing walk bounds the gain on the median PV',
    file: NCA,
    find: 'gainKw: gridGainKw(rateKw * legEff, h.pvP10W, acceptKw) });',
    to: 'gainKw: gridGainKw(rateKw * legEff, h.pvP50W ?? 0, acceptKw) }); /* MUTANT */',
    why: 'The worst case is sized on the median sun, not the low one it promises.',
  },
  {
    id: 'M-xiii. ★★ the EV disclosure counts the acceptance bound as contention',
    file: NCA,
    find: '  const contentionDerateKwh = Math.max(0, chargePowerLiftUncontendedKwh - chargeRateLiftKwh);',
    to: '  const contentionDerateKwh = Math.max(0, chargePowerLiftUncontendedKwh - chargePowerLiftKwh); /* MUTANT */',
    why: 'A sunny window with no car reports kWh cut by EV contention.',
  },

  /* ── the PV credit ── */
  {
    id: 'M-xiv. ★★★ the force-charge is bought PV-blind',
    file: NCA,
    find: '      liftKwh += fcLiftKwh - pvWalk(fcLiftKwh, jit.startMs).creditKwh;',
    to: '      liftKwh += fcLiftKwh; /* MUTANT */',
    why: 'The stated purchase counts the sun as grid: ~10 kWh too much on a sunny day.',
  },
  {
    id: 'M-xv. ★★★ the reserve leg is bought PV-blind',
    file: NCA,
    find: '  liftKwh -= reserveLeg.creditKwh;',
    to: '  /* MUTANT */',
    why: 'The 10:00 raise is stated as if the sun put nothing into it.',
  },
  {
    id: 'M-xvi. ★★ the house draws on the pool before the reserve leg is done',
    file: NCA,
    find: '      ...(reserveLeg.creditKwh > 0 ? { fromMs: reserveLeg.doneMs } : {}),',
    to: '      /* MUTANT */',
    why: 'The sun is counted twice: once in the reserve leg, again lifting the pool above the reserve.',
  },
  {
    id: 'M-xvii. ★★★ the sun is credited past the lift',
    file: NCA,
    find: '    const pvStep = Math.min((pvW / 1000) * dtH, o.liftKwh - gained);',
    to: '    const pvStep = (pvW / 1000) * dtH; /* MUTANT */',
    why: 'A short lift under a strong sun states a purchase smaller than nothing.',
  },
  {
    id: 'M-xviii. ★★ the walk forgets the grid fills the lift too',
    file: NCA,
    find: '    gained += pvStep + gridStep;',
    to: '    gained += pvStep; /* MUTANT */',
    why: 'The walk runs to the close and credits sun that lands after the pool is full.',
  },
  {
    id: 'M-xix. ★★ a minute with no P50 basis still credits sun',
    file: NCA,
    find: '    if (h == null) return { creditKwh: 0, doneMs: o.fromMs };',
    to: '    if (h == null) continue; /* MUTANT */',
    why: 'A missing forecast hour shrinks the stated purchase.',
  },
  {
    id: 'M-xx. ★★ the expected deliverable ignores the acceptance',
    file: NCA,
    find: '    kwh += gridGainKw(p50ChargeRateKw(h.loadP50W!, o.chargeCapKw, o.envelopeKw) * o.legEff, p50PvW(h), o.acceptKw ?? null) * availH;',
    to: '    kwh += p50ChargeRateKw(h.loadP50W!, o.chargeCapKw, o.envelopeKw) * o.legEff * availH; /* MUTANT */',
    why: 'The bound on the stated purchase counts grid the packs cannot take beside the sun.',
  },

  /* ── C_mid and the taper ── */
  {
    id: 'M-xxi. ★★★ C_mid measured from full, not the taper',
    file: NCA,
    find: '  if (o.curtailFromPct != null && Number.isFinite(o.curtailFromPct)) {',
    to: '  if (o.curtailFromPct != null && Number.isFinite(o.curtailFromPct) && (false as boolean)) { /* MUTANT */',
    why: 'The fill runs into the taper and the afternoon sun is shed.',
  },
  {
    id: 'M-xxii. ★★ C_mid leaves no room for the sun after the window',
    file: CT,
    find: '  const surplus = surplusKwh != null && Number.isFinite(surplusKwh) ? Math.max(0, surplusKwh) : 0;',
    to: '  const surplus = 0; /* MUTANT */',
    why: 'The 15:00–16:00 sun is curtailed against a full taper.',
  },
  {
    id: "M-xxiii. ★ the ceiling's basis is mislabelled",
    file: NCA,
    find: "    return { ceilingKwh: Math.min(socCap, curtailCap), basis: curtailCap <= socCap ? 'pv-curtail' : 'max-soc' };",
    to: "    return { ceilingKwh: Math.min(socCap, curtailCap), basis: curtailCap <= socCap ? 'pv-headroom' : 'max-soc' }; /* MUTANT */",
    why: 'The ledger says a mid-day ceiling was the morning-solar one.',
  },
  {
    id: "M-xxiv. ★★★ a mid-day window's surplus span is the overnight +14 h",
    file: CT,
    find: "  if (kind === 'super_off_peak' && nextOnPeakStartMs != null && Number.isFinite(nextOnPeakStartMs) && nextOnPeakStartMs >= windowEndMs) {",
    to: "  if (kind === 'super_off_peak' && nextOnPeakStartMs != null && Number.isFinite(nextOnPeakStartMs) && nextOnPeakStartMs >= windowEndMs && (false as boolean)) { /* MUTANT */",
    why: "Tomorrow morning's sun is counted against today's 15:00 fill.",
  },
  {
    id: 'M-xxv. ★★★ the taper band is 5 points',
    file: CT,
    find: 'export const CURTAIL_TAPER_BAND_PCT = 10;',
    to: 'export const CURTAIL_TAPER_BAND_PCT = 5; /* MUTANT */',
    why: 'Curtailment, soiling and the mid-day ceiling all read a taper that starts too late.',
  },
  {
    id: 'M-xxvi. ★★ the unreported ceiling is 96',
    file: CT,
    find: 'export const DEFAULT_CHARGE_CEILING_PCT = 100;',
    to: 'export const DEFAULT_CHARGE_CEILING_PCT = 96; /* MUTANT */',
    why: 'The old fixed threshold returns for a fleet that reports no ceiling.',
  },
  {
    id: 'M-xxvii. ★★ a zero ceiling counts in the mean',
    file: CT,
    find: '  const reported = ceilings.filter((v): v is number => v != null && v > 0);',
    to: '  const reported = ceilings.filter((v): v is number => v != null); /* MUTANT */',
    why: 'A Core reporting 0 drags the pool ceiling, and the taper, down.',
  },

  /* ── the backup anchors ── */
  {
    id: 'M-xxviii. ★★★ the islanded carry ignores the armed backup',
    file: NCA,
    find: '    if (!lifted && h.ts >= lift!.atMs) {',
    to: '    if (false as boolean) { /* MUTANT */',
    why: "The cost leg is sized from a pool the backup protects as if it did not: ~14 kWh too much.",
  },
  {
    id: 'M-xxix. ★★ the pre-window disclosure ignores the armed backup',
    file: NCA,
    find: '      dischargeEff, 0, windowStart, holdLift,\n',
    to: '      dischargeEff, 0, windowStart, /* MUTANT */\n',
    why: 'The plan states a 10:00 pool the backup would not leave.',
  },
  {
    id: 'M-xxx. ★★★ the backup hold outlives its window',
    file: NCA,
    find: '    const slotFloor = hold != null && slot < hold.untilMs ? Math.max(floor, Math.min(o.fullKwh, hold.kwh)) : floor;',
    to: '    const slotFloor = hold != null ? Math.max(floor, Math.min(o.fullKwh, hold.kwh)) : floor; /* MUTANT */',
    why: 'The expected pool is held at 50% through 05:00–10:00, when nothing holds it.',
  },
  {
    id: 'M-xxxi. ★★ the expected carry ignores the armed backup',
    file: NCA,
    find: '      ...(holdLift != null ? { hold: { kwh: holdLift.minKwh, untilMs: holdLift.atMs } } : {}),',
    to: '      /* MUTANT */',
    why: 'The expected 10:00 pool and the stated purchase ignore the backup that lifts it.',
  },
  {
    id: 'M-xxxii. ★★★ a closed backup still lifts the pool',
    file: NCA,
    find: '    && spec.backupHold.untilMs > nowMs',
    to: '    && true /* MUTANT */',
    why: 'A 06:00 recompute sizes from 50% when the pool really reads 30%.',
  },
  /* ── the re-entry hold (plan §3.3) ── */
  {
    id: 'M-xxxiii. ★★★ no re-entry hold',
    file: NCA,
    find: '    if (arrivalPct != null && linePct != null) {',
    to: '    if ((false as boolean) && arrivalPct != null && linePct != null) { /* MUTANT */',
    why: 'A 38% mid-day write leaves the pool where the panel holds it, and the grid carries the house into on-peak.',
  },
  {
    id: 'M-xxxiv. ★★ the re-entry margin is the measured 20 alone',
    file: NCA,
    find: 'export const MIDDAY_REENTRY_MARGIN_PCT = 25;',
    to: 'export const MIDDAY_REENTRY_MARGIN_PCT = 20; /* MUTANT */',
    why: 'A write at the measured re-entry point, with no margin, is armed.',
  },
  {
    id: 'M-xxxv. ★★ a write at the line holds',
    file: NCA,
    find: '  return levelPct < linePct ? linePct : null;',
    to: '  return levelPct <= linePct ? linePct : null; /* MUTANT */',
    why: 'A write that reaches the line is held for nothing.',
  },
  {
    id: 'M-xxxvi. ★★★ the line ignores the owner\'s floor',
    file: NCA,
    find: '  const linePct = round1(floorPct + MIDDAY_REENTRY_MARGIN_PCT);',
    to: '  const linePct = round1(16 + MIDDAY_REENTRY_MARGIN_PCT); /* MUTANT */',
    why: 'An owner floor of 30 still arms a 50% write the panel would hold at.',
  },
  {
    id: 'M-xxxvii. ★★ the shadow records a re-entry hold as "no buy needed"',
    file: SHADOW,
    find: '    const re = plan.middayReentryHold;',
    to: '    const re = null as { arrivalPct: number; linePct: number } | null; /* MUTANT */',
    why: 'The five-weekday review reads a re-entry hold as a day with nothing to buy.',
  },
  /* ── arming on the worst case ── */
  {
    id: 'M-xxxviii. ★★★ a leg arms on the expected figure only',
    file: ACT,
    find: '  if (plan.buyKwh == null || plan.buyKwh <= 0) return null;',
    to: '  { const e = (plan as unknown as { expectedBuyKwh?: number | null }).expectedBuyKwh; if (e != null ? e <= 0 : (plan.buyKwh == null || plan.buyKwh <= 0)) return null; } /* MUTANT */',
    why: 'A leg the median says needs nothing, but the islanded worst case needs, never arms: the resilience lift is lost.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-midday-plan', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
