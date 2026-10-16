#!/usr/bin/env node
/**
 * mutate-charge-cycle.mjs — the charge cycle (plan §7): its owner controls on the card (R0) and its
 * record (R3, chargeCycle.ts). The night-charge card offers the owner's Cancel in every shape it
 * takes (§5 "Card"): a write armed from the announced plan stands whatever a later recompute says,
 * so a hold, an incomplete basis, a stale plan or an unreadable status may not hide its Cancel, and
 * none of them may say "nothing will be charged" beside it. The cycle record holds one or two legs:
 * the active leg at the file's top level (a rollback still reverts it), the pending legs behind it
 * and a trailing one; one predicate (legResolved) lets the next leg go; the cancel and the drift
 * attribution are per leg; a missed apply of a new leg is pushed; each leg stamps its own columns.
 *
 *   K-i     the no-fresh-plan shape drops its Cancel
 *   K-ii    the hold shape drops its Cancel
 *   K-iii   the charge shape drops its Cancel
 *   K-iv    the unavailable shape drops its status-blind Cancel
 *   K-v     a hung status request holds the card on "Loading…" (no timeout)
 *   K-vi    the banner's Cancel is shown only once the write has applied
 *   K-vii   the hold shape ignores the standing write
 *   K-viii  the card holds a confirmed cancel as a flag that outlives its night
 *   K-ix    the banner's Cancel does not name its leg
 *   T-i     an armed write offers no Cancel
 *   T-ii    an applied write offers no Cancel
 *   T-iii   a restore the panel has not confirmed is shown as settled
 *   T-iv    a write "stands" in advisory mode
 *   T-v     a write whose window passed without a write still "stands"
 *   T-vi    a hold beside a standing write says "nothing will be charged"
 *   T-vii   a hold beside a standing write keeps its all-clear headline
 *   T-viii  the no-fresh-plan line ignores the standing write
 *   T-ix    a 409 (nothing armed) reads as cancelled
 *   T-x     a failed cancel removes the button
 *   T-xi    a confirmed cancel applies to every later write
 *   T-xii   a confirmed cancel of one leg applies to the other
 *   T-xiii  a reserve someone else set offers "Cancel & revert"
 *   T-xiv   a named leg is sent with no body
 *   File    F-i..F-vi    (the active leg at the top level; coerce; index.ts reads and writes the cycle)
 *   Resolve R-i..R-x     (legResolved and armOpenItem, promotion, trailing, the ceiling original,
 *                         a missed leg announced before it leaves)
 *   Arm     A-i..A-xiv   (armCycle; the trailing exception; the backup never force-charges; delivery;
 *                         the trailing leg as the ticks left it; supersede after the persist)
 *   Resend  N-i..N-iii   (blind OFF re-sends stop at the next cost leg's open; one leg: R1's bound)
 *   Cancel  C-i..C-v     (by leg; the pending legs before any 409)
 *   Drift   D-i..D-vi    (per leg; the overnight rule unchanged; the mid-day armed span dropped)
 *   Missed  M-i..M-v     (one push for a new leg; never for the overnight cost leg)
 *   Ledger  L-i..L-iv    (a leg's own columns; the lockstep migration)
 *
 *   node scripts/mutate-charge-cycle.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');
const WEB = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const CYC = resolve(REPO, 'server/src/chargeCycle.ts');
const ACT = resolve(REPO, 'server/src/nightChargeActuator.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const SUBSET = [
  'test/chargeCardCancel.test.ts',
  'test/dashboardAuditFour.test.ts',
  'test/nightChargeExpectedBuy.test.ts',
  'test/chargeCycle.test.ts',
  'test/ledgerChargeCycle.test.ts',
];

const MUTANTS = [
  // ── the card's shapes ──
  {
    id: 'K-i. ★★★ the no-fresh-plan shape drops its Cancel',
    file: CARD,
    find: "{noPlanText(plan != null && !plan.basisComplete, stands)}</div>\n        {banner('mt-3')}",
    to: "{noPlanText(plan != null && !plan.basisComplete, stands)}</div>\n        {/* MUTANT */}",
    why: 'A recompute that loses its basis, or a plan gone stale, leaves a raised reserve with no Cancel & revert on the card.',
  },
  {
    id: 'K-ii. ★★★ the hold shape drops its Cancel',
    file: CARD,
    find: "{hold.detail}</div>\n        {banner('mt-3')}",
    to: '{hold.detail}</div>\n        {/* MUTANT */}',
    why: 'A mid-window recompute that holds (the raised reserve has charged the pool) hides the applied write\'s Cancel & revert.',
  },
  {
    id: 'K-iii. ★★★ the charge shape drops its Cancel',
    file: CARD,
    find: "      {banner('mb-3')}\n",
    to: '      {/* MUTANT */}\n',
    why: 'The evening push says "Cancel from the charge card", and the card has none.',
  },
  {
    id: 'K-iv. ★★ the unavailable shape drops its status-blind Cancel',
    file: CARD,
    find: '        {err && <StatusBlindCancel />}',
    to: '        {/* MUTANT */}',
    why: 'A status route that fails leaves an armed write with no Cancel on the card.',
  },
  {
    id: 'K-v. ★★ a hung status request holds the card on "Loading…"',
    file: CARD,
    find: '      const timer = window.setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);',
    to: '      const timer = window.setTimeout(() => undefined, STATUS_TIMEOUT_MS); /* MUTANT */',
    why: 'A request that never answers keeps the loading shape, with no Cancel, until the browser gives up.',
  },
  {
    id: 'K-vi. ★★★ the banner\'s Cancel is shown only once the write has applied',
    file: CARD,
    find: '{state.cancel && <CancelButton label={state.cancel} busy={busy} onClick={doCancel} />}',
    to: '{state.cancel && actuation.appliedAtMs != null /* MUTANT */ && <CancelButton label={state.cancel} busy={busy} onClick={doCancel} />}',
    why: 'The owner cannot disarm the write before the window opens — the cancel window the evening push announced.',
  },
  {
    id: 'K-vii. ★★ the hold shape ignores the standing write',
    file: CARD,
    find: '    const hold = holdSummary(plan, { writeStands: stands });',
    to: '    const hold = holdSummary(plan); /* MUTANT */',
    why: '"No overnight charge needed … nothing will be charged" above "Reserve raised to 50% (was 16%)".',
  },
  {
    id: 'K-viii. ★★★ the card holds a confirmed cancel as a flag that outlives its night',
    file: CARD,
    find: '  const actuation = withConfirmedCancel(status.actuation ?? null, cancelledKey);',
    to: '  const actuation = cancelledKey != null && status.actuation ? { ...status.actuation, cancelled: true } : status.actuation ?? null; /* MUTANT */',
    why: 'On a card left open, the next evening\'s write shows "Cancelled — no write tonight." with no Cancel.',
  },
  // ── the pure rules ──
  {
    id: 'T-i. ★★★ an armed write offers no Cancel',
    file: WEB,
    find: "settled: false, cancel: 'Cancel tonight' };",
    to: 'settled: false, cancel: null }; /* MUTANT */',
    why: 'Between the evening push and the window open the owner has no way to disarm the write.',
  },
  {
    id: 'T-ii. ★★★ an applied write offers no Cancel',
    file: WEB,
    find: "settled: false, cancel: 'Cancel & revert' };",
    to: 'settled: false, cancel: null }; /* MUTANT */',
    why: 'A raised reserve cannot be reverted from the card until the window closes.',
  },
  {
    id: 'T-iii. ★★ a restore the panel has not confirmed is shown as settled',
    file: WEB,
    find: "back at ${prior}%.`, settled: false, cancel: null };",
    to: "back at ${prior}%.`, settled: true, cancel: null }; /* MUTANT */",
    why: 'The reserve may still be raised and the actuator is escalating, and the banner reads as done.',
  },
  {
    id: 'T-iv. ★★ a write "stands" in advisory mode',
    file: WEB,
    find: "  return mode !== 'advisory' && a != null && actuationBannerVisible(a, nowMs) && actuationBannerState(a, null).cancel != null;",
    to: '  return a != null && actuationBannerVisible(a, nowMs) && actuationBannerState(a, null).cancel != null; /* MUTANT */',
    why: 'An advisory card, which shows no banner, says "the armed write stands; cancel it below" over nothing.',
  },
  {
    id: 'T-v. ★★ a write whose window passed without a write still "stands"',
    file: WEB,
    find: "  return mode !== 'advisory' && a != null && actuationBannerVisible(a, nowMs) && actuationBannerState(a, null).cancel != null;",
    to: "  return mode !== 'advisory' && a != null && actuationBannerState(a, null).cancel != null; /* MUTANT */",
    why: 'The day after a missed apply, the card says a write stands that will never be made.',
  },
  {
    id: 'T-vi. ★★★ a hold beside a standing write says "nothing will be charged"',
    file: WEB,
    find: "  const hold = holdVerdict(plan, stands ? 'the latest recompute would charge nothing' : 'nothing will be charged');",
    to: "  const hold = holdVerdict(plan, 'nothing will be charged'); /* MUTANT */",
    why: '"nothing will be charged" beside "Supervised write armed — reserve → 50% at 22:55".',
  },
  {
    id: 'T-vii. ★★ a hold beside a standing write keeps its all-clear headline',
    file: WEB,
    find: '  return stands ? { headline: WRITE_STANDS_HEADLINE',
    to: '  return false /* MUTANT */ && stands ? { headline: WRITE_STANDS_HEADLINE',
    why: '"No overnight charge needed." in green above a raised reserve.',
  },
  {
    id: 'T-viii. ★★ the no-fresh-plan line ignores the standing write',
    file: WEB,
    find: '  if (stands) {\n    return `${basisIncomplete',
    to: '  if (false /* MUTANT */) {\n    return `${basisIncomplete',
    why: '"basis incomplete; nothing will be charged" above an armed write.',
  },
  {
    id: 'T-ix. ★★ a 409 (nothing armed) reads as cancelled',
    file: WEB,
    find: '  if (httpStatus >= 200 && httpStatus < 300) {',
    to: '  if (httpStatus >= 200 && httpStatus < 500) { /* MUTANT */',
    why: 'The status-blind Cancel says "Cancelled" when the server refused: nothing was armed, or the write already reverted.',
  },
  {
    id: 'T-x. ★★ a failed cancel removes the button',
    file: WEB,
    find: 'return { ok: false, done: false, text: `cancel failed (HTTP ${httpStatus})` };',
    to: 'return { ok: false, done: true, text: `cancel failed (HTTP ${httpStatus})` }; /* MUTANT */',
    why: 'A cancel that failed on a transient error cannot be tried again from the status-blind Cancel.',
  },
  {
    id: 'T-xi. ★★★ a confirmed cancel applies to every later write',
    file: WEB,
    // R3 — re-pointed: the key names the leg too.
    find: "  return a == null || a.day == null ? null : `${a.day}|${a.leg ?? 'cost'}|${a.windowStartMs ?? '-'}`;",
    to: "  return a == null || a.day == null ? null : 'any'; /* MUTANT */",
    why: 'After one cancel, every later night\'s write shows "Cancelled" on a card left open, with no Cancel.',
  },
  {
    id: 'T-xii. ★★ a confirmed cancel of one leg applies to the other',
    file: WEB,
    find: "  return a == null || a.day == null ? null : `${a.day}|${a.leg ?? 'cost'}|${a.windowStartMs ?? '-'}`;",
    to: "  return a == null || a.day == null ? null : `${a.day}|${a.windowStartMs ?? '-'}`; /* MUTANT */",
    why: 'Cancelling tonight\'s outage backup shows the daytime charge (same plan date) as cancelled, with no Cancel.',
  },
  {
    id: 'T-xiii. ★★ a reserve someone else set offers "Cancel & revert"',
    file: WEB,
    find: '  if (a.foreignSettledAtMs != null) {\n    return { text: `The reserve was set to',
    to: '  if (false /* MUTANT */) {\n    return { text: `The reserve was set to',
    why: 'The card offers to revert a reserve the owner set; the server answers 409.',
  },
  {
    id: 'T-xiv. ★★ a named leg is sent with no body',
    file: WEB,
    find: "  return leg == null ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leg }) };",
    to: "  return { method: 'POST' }; /* MUTANT */",
    why: '"Also cancel tonight\'s outage backup" cancels the daytime charge instead (the server\'s default leg).',
  },
  {
    id: 'K-ix. ★★ the banner\'s Cancel does not name its leg',
    file: CARD,
    find: '    const out = await postCancel(actuation.leg ?? null);',
    to: '    const out = await postCancel(); /* MUTANT */',
    why: 'The backup leg\'s banner cancels the daytime charge.',
  },
  // ── the file ──
  {
    id: 'F-i. ★★★ the file nests the active leg (a rollback finds no record)',
    file: CYC,
    find: '  return { ...c.active, cycleVersion: CYCLE_FILE_VERSION, pendingLegs: c.pendingLegs, trailing: c.trailing };',
    to: '  return { active: c.active, cycleVersion: CYCLE_FILE_VERSION, pendingLegs: c.pendingLegs, trailing: c.trailing }; /* MUTANT */',
    why: 'Rolled back to v1.188, the add-on reads an idle record and never reverts a raised reserve.',
  },
  {
    id: 'F-ii. ★★ a pending leg of another plan date is kept',
    file: CYC,
    find: '.filter((l) => l.day != null && l.day === active.day)',
    to: '.filter((l) => l.day != null) /* MUTANT */',
    why: 'A stray leg from another evening is promoted behind tonight\'s and writes.',
  },
  {
    id: 'F-iii. ★★ an unknown leg name reads as the cost leg (it may force-charge)',
    file: CYC,
    find: "  const leg: ChargeLegRole = o.leg === undefined || o.leg === 'cost' ? 'cost' : 'backup';",
    to: "  const leg: ChargeLegRole = o.leg === 'backup' ? 'backup' : 'cost'; /* MUTANT */",
    why: 'A corrupt name turns a reserve-only leg into one that force-charges.',
  },
  {
    id: 'F-iv. ★★★ index.ts persists the bare record (the pending legs are lost)',
    file: IDX,
    find: '    atomicWriteFileSync(NIGHT_CHARGE_ACTUATION_PATH, JSON.stringify(serializeCycle(nightCycleView())));',
    to: '    atomicWriteFileSync(NIGHT_CHARGE_ACTUATION_PATH, JSON.stringify(nightActuationMem)); /* MUTANT */',
    why: 'A restart forgets the daytime charge armed behind tonight\'s backup, and a trailing OFF.',
  },
  {
    id: 'F-v. ★★ index.ts reads the file as one record',
    file: IDX,
    find: "    return coerceCycle(JSON.parse(readFileSync(NIGHT_CHARGE_ACTUATION_PATH, 'utf8')));",
    to: "    return coerceCycle({ ...JSON.parse(readFileSync(NIGHT_CHARGE_ACTUATION_PATH, 'utf8')), pendingLegs: [], trailing: null }); /* MUTANT */",
    why: 'A restart drops the pending and trailing legs.',
  },
  {
    id: 'F-vi. ★★ the active leg loses its name on every write',
    file: IDX,
    find: '  nightActuationMem = asChargeLeg(s);',
    to: '  nightActuationMem = asChargeLeg({ ...s, leg: undefined, windowKind: undefined } as NightActuationState); /* MUTANT */',
    why: 'A backup leg becomes the cost leg on its first write: it may force-charge, and its stamps land in the cost columns.',
  },
  // ── resolution and promotion ──
  {
    id: 'R-i. ★★★ promote on an unconfirmed write',
    file: CYC,
    find: '  if (armOpenItem(s, liveReservePct) != null) return false; // includes a force-charge OFF not read back',
    to: '  /* MUTANT */',
    why: 'An attempted backup write that landed is buried behind the cost leg: ADOPT never reverts it.',
  },
  {
    id: 'R-ii. ★★★ promote on a restore that has not read back',
    file: CYC,
    find: '  return !(s.appliedAtMs != null && s.revertVerifiedAtMs == null && s.foreignSettledAtMs == null);',
    to: '  return true; /* MUTANT */',
    why: 'The cost leg takes over while the backup\'s 50% may still stand, and its retries stop.',
  },
  {
    id: 'R-iii. ★★★ the open item forgets a force-charge OFF not read back (promotion and arming alike)',
    file: ACT,
    find: '  if (prev.forceChargeOnAtMs != null && prev.forceChargeOffVerifiedAtMs == null) {\n    return `the ${night} force-charge was switched ON',
    to: '  if (false && prev.forceChargeOnAtMs != null) { /* MUTANT */\n    return `the ${night} force-charge was switched ON',
    why: 'The cost leg takes over, and the next evening arms, over a force-charge that may still be ON.',
  },
  {
    id: 'R-iv. ★★ an armed leg counts as finished',
    file: CYC,
    find: '  return s.appliedAtMs == null && s.windowStartMs != null && nowMs > s.windowStartMs + APPLY_LATE_MS;',
    to: '  return s.appliedAtMs == null; /* MUTANT */',
    why: 'The backup is promoted away at 21:31, before its window: tonight\'s outage backup never writes.',
  },
  {
    id: 'R-v. ★★★ promotion ignores the trailing leg',
    file: CYC,
    find: '  if (cycle.pendingLegs.length > 0 && cycle.trailing == null && legResolved(cycle.active, nowMs, liveReservePct)\n      && !missedApplyDue(cycle.active, nowMs)) {',
    to: '  if (cycle.pendingLegs.length > 0 && legResolved(cycle.active, nowMs, liveReservePct)\n      && !missedApplyDue(cycle.active, nowMs)) { /* MUTANT */',
    why: 'The cost leg force-charges while the previous leg\'s force-charge is not yet confirmed off.',
  },
  {
    id: 'R-vi. ★★ a trailing leg resolves with its ceiling restore still in progress',
    file: CYC,
    find: '  return !ceilingRestorePending(t) || t.forceChargeCeilingRestoreAttempts >= FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS;',
    to: '  return true; /* MUTANT */',
    why: 'The panel\'s own Charge Now ceiling is abandoned at our 85%.',
  },
  {
    id: 'R-vii. ★★ the ceiling original does not travel',
    file: CYC,
    find: '  if (!ceilingRestorePending(from) || to.forceChargeCeilingPriorPct != null) return to;',
    to: '  return to; /* MUTANT */',
    why: 'The next leg captures our own ceiling as the panel\'s, and restores that.',
  },
  {
    id: 'R-viii. ★★ a trailing leg that resolved never leaves',
    file: CYC,
    find: '  if (cycle.trailing != null && trailingResolved(cycle.trailing)) {',
    to: '  if (cycle.trailing != null && trailingResolved(cycle.trailing) && Number.isNaN(0) /* MUTANT */) {',
    why: 'The cost leg waits forever behind a trailing leg already done, and is missed.',
  },
  {
    id: 'R-ix. ★★ the promotion reads a frozen reserve projection',
    file: IDX,
    find: '  const step = promoteCycle(nightCycleView(), nowMs, freshReserveReadingPct(nowMs));',
    to: '  const step = promoteCycle(nightCycleView(), nowMs, liveReserveSocPct()); /* MUTANT */',
    why: 'A cloud-dark panel\'s last sample "proves" an attempted write never landed.',
  },
  {
    id: 'R-x. ★★★ a missed leg is promoted away before its push',
    file: CYC,
    find: '      && !missedApplyDue(cycle.active, nowMs)) {',
    to: '      ) { /* MUTANT */',
    why: 'Tonight\'s outage backup is missed (its apply window passes with no write) and nothing says so: the cycle step promotes it in the same tick, before the push step reads it.',
  },
  // ── arming ──
  {
    id: 'A-i. ★★★ the trailing exception for any first leg (a cost leg arms over an unverified OFF)',
    file: CYC,
    find: '    const over = i === 0 && backup && onlyForceChargeOffOpen(prev.active, liveReservePct) ? emptyActuationState() : carrier;',
    to: '    const over = i === 0 && onlyForceChargeOffOpen(prev.active, liveReservePct) ? emptyActuationState() : carrier; /* MUTANT */',
    why: 'One leg: tonight arms over last night\'s force-charge still ON — today\'s refusal is gone.',
  },
  {
    id: 'A-ii. ★★★ a backup that does not arm clears the open item for the cost leg',
    file: CYC,
    find: "      refused.push({ role: c.role, reason: armRefusalReason(over, plan, nowMs, liveReservePct) ?? 'the plan does not arm' });\n      return;",
    to: "      refused.push({ role: c.role, reason: armRefusalReason(over, plan, nowMs, liveReservePct) ?? 'the plan does not arm' });\n      carrier = emptyActuationState(); /* MUTANT */\n      return;",
    why: 'A held backup lets the cost leg arm over a force-charge that may still be ON.',
  },
  {
    id: 'A-iii. ★★★ the backup leg may force-charge (the option rides it)',
    file: CYC,
    find: '    const fc = backup ? false : c.forceChargeEnabled;',
    to: '    const fc = c.forceChargeEnabled; /* MUTANT */',
    why: 'The overnight backup is stamped to ride a force-charge.',
  },
  {
    id: 'A-iv. ★★★ the backup leg keeps the plan\'s cost ceiling',
    file: CYC,
    find: '    const plan: ArmablePlan = backup ? { ...c.plan, costCeilingSocPct: null } : c.plan;',
    to: '    const plan: ArmablePlan = c.plan; /* MUTANT */',
    why: 'A reserve-only leg arms a force-charge ceiling.',
  },
  {
    id: 'A-v. ★★ every armed leg carries the ceiling original',
    file: CYC,
    find: '    }));\n    carrier = emptyActuationState();\n  });',
    to: '    }));\n  }); /* MUTANT */',
    why: 'Two legs restore the panel\'s ceiling, and the second captures ours.',
  },
  {
    id: 'A-vi. ★★★ an open trailing leg does not refuse the next cycle',
    file: CYC,
    find: '  if (prev.trailing != null && !trailingResolved(prev.trailing)) {\n    const why',
    to: '  if (prev.trailing != null && !trailingResolved(prev.trailing) && Number.isNaN(0) /* MUTANT */) {\n    const why',
    why: 'The next arm buries a force-charge OFF still to verify.',
  },
  {
    id: 'A-vii. ★★★ index.ts persists the cycle before it is delivered',
    file: IDX,
    find: '      armedCycle = arm.cycle;',
    to: '      armedCycle = arm.cycle; if (arm.cycle) persistCycle(arm.cycle); /* MUTANT */',
    why: 'A write the owner never heard about fires.',
  },
  {
    id: 'A-viii. ★★ a stale prior arm leaves its pending legs',
    file: IDX,
    find: '  nightCyclePending = [];\n  persistNightActuation(emptyActuationState());',
    to: '  persistNightActuation(emptyActuationState()); /* MUTANT */',
    why: 'Tonight holds, and Saturday\'s daytime leg is promoted and writes anyway.',
  },
  // ── cancel ──
  {
    id: 'C-i. ★★★ 409 with a pending leg: no leg named cancels the active one',
    file: CYC,
    find: "    ? legs.find((l) => l.leg.leg === 'cost') ?? legs.find((l) => l.where === 'active')",
    to: "    ? legs.find((l) => l.where === 'active') /* MUTANT */",
    why: 'At 05:02 "Cancel tomorrow\'s charge" answers "already completed" for the backup; the daytime charge runs.',
  },
  {
    id: 'C-ii. ★★ a leg already restored can be cancelled again',
    file: CYC,
    find: "  if (s.revertedAtMs != null) return { ok: false, error: 'tonight’s write already completed and reverted' };",
    to: '  /* MUTANT */',
    why: 'A completed night reads "Cancelled — the applied write reverts", and nothing is.',
  },
  {
    id: 'C-iii. ★★ an invalid leg is read as none',
    file: CYC,
    find: "  return leg === 'cost' || leg === 'backup' ? leg : undefined;",
    to: "  return leg === 'cost' || leg === 'backup' ? leg : null; /* MUTANT */",
    why: 'A mistyped leg cancels the daytime charge instead of answering 400.',
  },
  {
    id: 'C-iv. ★★★ the route ignores the leg named',
    file: IDX,
    find: '  const r = cancelLeg(nightCycleView(), want);',
    to: '  const r = cancelLeg(nightCycleView(), null); /* MUTANT */',
    why: '"Also cancel tonight\'s outage backup" cancels the daytime charge.',
  },
  {
    id: 'C-v. ★★ status legs[] omit the pending legs',
    file: CYC,
    find: "  for (const p of c.pendingLegs) out.push(one(p, 'pending'));",
    to: '  /* MUTANT */',
    why: 'The card cannot show, or cancel, the daytime charge armed behind tonight\'s backup.',
  },
  // ── drift ──
  {
    id: 'D-i. ★★★ narrowed drift: the overnight leg loses its armed span',
    file: CYC,
    find: "  if (leg.windowKind === 'overnight') {\n    return (leg.appliedAtMs",
    to: "  if (leg.windowKind === 'overnight' && Number.isNaN(0) /* MUTANT */) {\n    return (leg.appliedAtMs",
    why: 'One leg: an attribution that has held since v1.83.0 changes.',
  },
  {
    id: 'D-ii. ★★★ the mid-day leg keeps the armed 21:30 → 10:00 span',
    file: CYC,
    find: "  if (leg.windowKind === 'overnight') {\n    return (leg.appliedAtMs",
    to: "  if (leg.windowKind === 'overnight' || !Number.isNaN(0) /* MUTANT */) {\n    return (leg.appliedAtMs",
    why: 'An owner setting the reserve to 50% overnight is never told: it reads as our write for twelve hours.',
  },
  {
    id: 'D-iii. ★★ the restore tail counts from the first restore',
    file: CYC,
    find: '    const last = Math.max(leg.revertedAtMs, leg.revertLastAttemptMs ?? leg.revertedAtMs);',
    to: '    const last = leg.revertedAtMs; /* MUTANT */',
    why: 'Our own re-issued 15:06 restore is pushed as an external change.',
  },
  {
    id: 'D-iv. ★★ the apply window ignores a cancel',
    file: CYC,
    find: '      && !(leg.cancelled && leg.applyAttemptedAtMs == null)) return true;',
    to: '      ) return true; /* MUTANT */',
    why: 'After a cancel, an owner\'s 50% at 10:05 reads as our write.',
  },
  {
    id: 'D-v. ★★ index.ts attributes the active leg only',
    file: IDX,
    find: '  const own = cycleDriftLeg(nightCycleView(), nowMs);',
    to: '  const own = cycleDriftLeg({ ...nightCycleView(), pendingLegs: [], trailing: null }, nowMs); /* MUTANT */',
    why: 'The pending leg\'s and the trailing leg\'s writes are pushed as external changes.',
  },
  {
    id: 'D-vi. ★★ the trailing leg\'s OFF re-sends are not ours',
    file: IDX,
    find: '  const act = nightCycleTrailing != null && forceChargeDriftActive(nightCycleTrailing, nowMs) ? nightCycleTrailing : nightActuationMem;',
    to: '  const act = nightActuationMem; /* MUTANT */',
    why: 'Each OFF the trailing leg sends is pushed as "Setting changed externally".',
  },
  // ── the missed apply ──
  {
    id: 'M-i. ★★★ a silent missed apply',
    file: CYC,
    find: "  return leg.leg === 'backup' || leg.windowKind !== 'overnight';",
    to: '  return false; /* MUTANT */',
    why: 'Today\'s 10am–3pm charge does not start and nothing says so.',
  },
  {
    id: 'M-ii. ★★★ the overnight cost leg pushes a missed apply',
    file: CYC,
    find: "  return leg.leg === 'backup' || leg.windowKind !== 'overnight';",
    to: '  return true; /* MUTANT */',
    why: 'One leg: a push the overnight cycle never sent.',
  },
  {
    id: 'M-iii. ★★ the missed apply is never stamped',
    file: IDX,
    find: '  const stamped: ChargeLegState = { ...leg, missedApplyPushedAtMs: nowMs };',
    to: '  const stamped: ChargeLegState = { ...leg }; /* MUTANT */',
    why: 'The push repeats every minute.',
  },
  {
    id: 'M-iv. ★★ the tick never runs the missed apply',
    file: IDX,
    find: '    try { await runMissedApplyStep(); }',
    to: '    try { /* MUTANT */ }',
    why: 'A leg that does not start is silent.',
  },
  {
    id: 'M-v. ★★ a pending leg missed behind an open leg names no cause',
    file: CYC,
    find: '  if (ctx.blockedBy != null) {',
    to: '  if (ctx.blockedBy != null && Number.isNaN(0) /* MUTANT */) {',
    why: '"no write was issued" when the backup\'s restore never read back.',
  },
  // ── the trailing leg and the backup never switch ON ──
  {
    id: 'A-ix. ★★★ the trailing leg may switch force-charge ON',
    file: IDX,
    find: '  const action = decideForceCharge(t, nowMs, {\n    enabled: false,',
    to: '  const action = decideForceCharge(t, nowMs, {\n    enabled: forceChargeOn(), /* MUTANT */',
    why: 'A leg that only owes an OFF can start a charge.',
  },
  {
    id: 'A-x. ★★★ the backup leg force-charges by the option',
    file: IDX,
    find: '    enabled: !opts.forceDisabled && forceChargeOn(legRoleOf(state)),',
    to: '    enabled: !opts.forceDisabled && forceChargeOn(), /* MUTANT */',
    why: 'The reserve-only backup force-charges overnight.',
  },
  {
    id: 'A-xi. ★★ the tick never drives the trailing leg',
    file: IDX,
    find: '    try { await runTrailingLegTick(); }',
    to: '    try { /* MUTANT */ }',
    why: 'A trailing force-charge is never confirmed off; the cost leg waits and is missed.',
  },
  {
    id: 'A-xii. ★★ the persisted arm takes the arm-time copy of the trailing leg',
    file: CYC,
    find: '  return { ...armed, trailing: liveActive };',
    to: '  return armed; /* MUTANT */',
    why: 'An OFF read back (or a page stamped) while the announcement was awaited is erased: the OFF is re-verified, a page repeats.',
  },
  {
    id: 'A-xiii. ★★ index.ts persists the arm-time cycle',
    file: IDX,
    find: '        persistCycle(withLiveTrailing(armedCycle!, nightActuationMem));',
    to: '        persistCycle(armedCycle!); /* MUTANT */',
    why: 'As A-xii, at the call.',
  },
  {
    id: 'A-xiv. ★★ a superseded pending leg is never stamped',
    file: IDX,
    find: '        for (const { leg, sharedWindow } of supersededPending) {',
    to: '        for (const { leg, sharedWindow } of [] as typeof supersededPending) { /* MUTANT */',
    why: 'A prior cycle\'s daytime leg replaced by tonight\'s arm keeps a NULL disposition: an armed charge that never ran, unexplained.',
  },
  // ── blind OFF re-sends ──
  {
    id: 'N-i. ★★★ the backup leg\'s open bounds the re-sends',
    file: CYC,
    find: "  const next = after.find((l) => l.day != null && l.leg === 'cost' && l.windowStartMs != null && l.windowStartMs >= end);",
    to: "  const next = after.find((l) => l.day != null && l.windowStartMs != null && l.windowStartMs >= end); /* MUTANT */",
    why: 'A trailing force-charge with no live readback stops being switched off at midnight, ten hours before anything of ours could need the slots.',
  },
  {
    id: 'N-ii. ★★★ one leg: the plan\'s window no longer bounds the re-sends',
    file: CYC,
    find: '  return planWindowStartMs != null && planWindowStartMs >= end ? planWindowStartMs : null;',
    to: '  return null; /* MUTANT */',
    why: 'R1\'s bound is gone: a blind OFF can be re-sent into the next night\'s force-charge.',
  },
  {
    id: 'N-iii. ★★ the active leg\'s re-sends ignore the pending legs',
    file: IDX,
    find: '    nextLegOpenMs: nextForceChargeOpenMs(state, nightCyclePending, fcPlan?.window?.startMs),',
    to: '    nextLegOpenMs: nextForceChargeOpenMs(state, [], fcPlan?.window?.startMs), /* MUTANT */',
    why: 'A blind OFF can be re-sent into the cycle\'s next force-charge.',
  },
  // ── the ledger ──
  {
    id: 'L-i. ★★★ a backup leg\'s stamps land in the cost leg\'s columns',
    file: CYC,
    find: "  if (role !== 'backup') return fields;",
    to: '  return fields; /* MUTANT */',
    why: 'The backup\'s 00:00 apply is recorded as the daytime charge: actuated, applied at midnight.',
  },
  {
    id: 'L-ii. ★★★ the columns drop out of the ALTER pass (SILENT)',
    file: REC,
    find: '    ...CHARGE_CYCLE_LEDGER_SCHEMA.map(([c, t]) => `${c} ${t}`),',
    to: '    /* MUTANT */',
    why: 'An existing database never gains the columns, and every write to them fails or is lost.',
  },
  {
    id: 'L-iii. ★★★ the columns drop out of the allowlist (SILENT)',
    file: REC,
    find: '  ...CHARGE_CYCLE_LEDGER_COLUMNS,\n];',
    to: '  /* MUTANT */\n];',
    why: 'Every charge-cycle stamp is dropped by the upsert.',
  },
  {
    id: 'L-iv. ★★ the reserve tick stamps the cost columns directly',
    file: IDX,
    find: '      stampLegOutcome(state, { actuated: 1, actuation_applied_at_ms: nowMs });',
    to: '      try { recorder.recordNightOutcome(state.day, { actuated: 1, actuation_applied_at_ms: nowMs }); } catch { /* MUTANT */ }',
    why: 'A backup leg\'s apply is recorded in the cost leg\'s columns.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-charge-cycle', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
