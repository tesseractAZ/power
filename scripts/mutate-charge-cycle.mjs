#!/usr/bin/env node
/**
 * mutate-charge-cycle.mjs — the charge cycle's owner controls (plan §7). The night-charge card offers
 * the owner's Cancel in every shape it takes (§5 "Card"): a write armed from the announced plan
 * stands whatever a later recompute says, so a hold, an incomplete basis, a stale plan or an
 * unreadable status may not hide its Cancel, and none of them may say "nothing will be charged"
 * beside it.
 *
 *   K-i     the no-fresh-plan shape drops its Cancel
 *   K-ii    the hold shape drops its Cancel
 *   K-iii   the charge shape drops its Cancel
 *   K-iv    the unavailable shape drops its status-blind Cancel
 *   K-v     a hung status request holds the card on "Loading…" (no timeout)
 *   K-vi    the banner's Cancel is shown only once the write has applied
 *   K-vii   the hold shape ignores the standing write
 *   K-viii  the card holds a confirmed cancel as a flag that outlives its night
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
 *
 *   node scripts/mutate-charge-cycle.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');
const WEB = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const SUBSET = [
  'test/chargeCardCancel.test.ts',
  'test/dashboardAuditFour.test.ts',
  'test/nightChargeExpectedBuy.test.ts',
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
    find: "  return a == null || a.day == null ? null : `${a.day}|${a.windowStartMs ?? '-'}`;",
    to: "  return a == null || a.day == null ? null : 'any'; /* MUTANT */",
    why: 'After one cancel, every later night\'s write shows "Cancelled" on a card left open, with no Cancel.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-charge-cycle', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
