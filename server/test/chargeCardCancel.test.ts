/**
 * The night-charge card offers the owner's Cancel in every shape it takes (plan §5 "Card", slice
 * R0). The banner and its Cancel rendered only on a fresh charge plan: the shapes for a hold, an
 * incomplete basis or a stale plan, and the unavailable shape, returned before it. A write the
 * evening job arms from the ANNOUNCED plan is never replaced by a later recompute
 * (nightChargeActuator.ts), and the plan is recomputed every 30 minutes — so a recompute that holds
 * (once the raised reserve has charged the pool, say) showed "No overnight charge needed … nothing
 * will be charged" while the reserve sat raised, with no way to cancel or revert it from the card.
 *
 * The card itself is not reachable from a unit test: its words and its Cancel are pure
 * (nightChargeText.ts) and tested here, and the card's shapes are checked from its source — every
 * `return (` block of the card component must render a Cancel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  actuationBannerState, actuationBannerVisible, actuationKey, cancelOutcome, cancelRequestInit, holdSummary, noPlanText, withConfirmedCancel,
  writeStands, COMPLETED_BANNER_MS, WRITE_STANDS_HEADLINE, WRITE_STANDS_NOTE, type BannerTextActuation, type HoldSummaryPlan,
} from '../../web/src/cards/nightChargeText.js';

const H = 3_600_000;
const phx = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h + 7, mi);
const NOW = phx(10, 12, 21, 45);
const WIN_START = phx(10, 12, 23);
const WIN_END = phx(10, 13, 5);

const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
const web = readFileSync(new URL('../../web/src/cards/nightChargeText.ts', import.meta.url), 'utf8');

/** Tonight's write, armed at 21:30 for the 23:00–05:00 window. */
const armed = (over: Partial<BannerTextActuation & { windowStartMs: number | null }> = {}): BannerTextActuation & { windowStartMs: number | null } => ({
  day: '2026-10-12', targetPct: 50, priorReservePct: 16, appliedAtMs: null, revertedAtMs: null, cancelled: false,
  windowStartMs: WIN_START, windowEndMs: WIN_END, cancelDeadlineMs: WIN_START - 5 * 60_000, ...over,
});
const applied = (over: Partial<BannerTextActuation> = {}) => armed({ appliedAtMs: WIN_START + 60_000, ...over });

/* ── the banner's words and its Cancel ───────────────────────────────────────────────────── */

test('★★★ the banner offers Cancel exactly while a write is armed or applied, and states each state', () => {
  assert.deepEqual(actuationBannerState(armed(), '22:55'), {
    text: 'Supervised write armed — reserve → 50% at 22:55.', settled: false, cancel: 'Cancel tonight',
  });
  assert.equal(actuationBannerState(armed(), null).text, 'Supervised write armed — reserve → 50%.');
  assert.deepEqual(actuationBannerState(applied(), '22:55'), {
    text: 'Reserve raised to 50% (was 16%); auto-restores after the window closes.', settled: false, cancel: 'Cancel & revert',
  });
  // Settled: nothing left to cancel, shown muted.
  assert.deepEqual(actuationBannerState(armed({ cancelled: true }), '22:55'), { text: 'Cancelled — no write tonight.', settled: true, cancel: null });
  assert.deepEqual(actuationBannerState(applied({ cancelled: true }), null), {
    text: 'Cancelled — the applied write reverts within a minute.', settled: true, cancel: null,
  });
  assert.deepEqual(actuationBannerState(applied({ revertedAtMs: WIN_END, revertVerifiedAtMs: WIN_END + 60_000 }), null), {
    text: 'Completed — reserve restored to 16%.', settled: true, cancel: null,
  });
  // A restore the panel has not confirmed: never "Completed", never muted — cancelled or not —
  // and nothing to cancel (the actuator is retrying it; the cancel route answers 409).
  for (const c of [false, true]) {
    assert.deepEqual(actuationBannerState(applied({ cancelled: c, revertedAtMs: WIN_END, revertVerifiedAtMs: null, revertRetries: 1 }), null), {
      text: 'Restore not confirmed — the panel has not reported the reserve back at 16%.', settled: false, cancel: null,
    }, `cancelled: ${c}`);
  }
  // No prior or target on record: a dash, never "null%".
  assert.equal(actuationBannerState(applied({ priorReservePct: null, targetPct: null }), null).text,
    'Reserve raised to —% (was —%); auto-restores after the window closes.');
});

test('★★★ writeStands: a write armed from the announced plan stands until it is cancelled or reverted, whatever the recompute says', () => {
  for (const mode of ['supervised', 'auto']) {
    assert.equal(writeStands(armed(), mode, NOW), true, `${mode}: armed`);
    assert.equal(writeStands(applied(), mode, WIN_START + 2 * H), true, `${mode}: applied`);
    // Applied and the window long over, not yet reverted: still raised, still cancellable.
    assert.equal(writeStands(applied(), mode, WIN_END + 3 * H), true, `${mode}: applied, past its window`);
  }
  // Advisory mode arms nothing and shows no banner; a record left from a write mode does not stand there.
  assert.equal(writeStands(armed(), 'advisory', NOW), false);
  assert.equal(writeStands(applied(), 'advisory', WIN_START + H), false);
  assert.equal(writeStands(null, 'supervised', NOW), false);
  assert.equal(writeStands(armed({ day: null }), 'supervised', NOW), false, 'idle');
  assert.equal(writeStands(armed({ cancelled: true }), 'supervised', NOW), false);
  assert.equal(writeStands(applied({ cancelled: true }), 'supervised', WIN_START + H), false);
  assert.equal(writeStands(applied({ revertedAtMs: WIN_END, revertVerifiedAtMs: WIN_END }), 'supervised', WIN_END + 60_000), false);
  assert.equal(writeStands(applied({ revertedAtMs: WIN_END, revertVerifiedAtMs: null, revertReadbackEscalated: true }), 'supervised', WIN_END + H), false,
    'a restore not confirmed is no longer a write that stands (nothing to cancel)');
  // Armed, but its window passed without a write: nothing will apply.
  assert.equal(writeStands(armed(), 'supervised', WIN_END + 2 * H), false);
  // It is the banner's own condition: wherever it stands, the banner is shown with its Cancel.
  for (const [a, now] of [[armed(), NOW], [applied(), WIN_START + H], [armed({ cancelled: true }), NOW], [armed(), WIN_END + 2 * H]] as const) {
    assert.equal(writeStands(a, 'supervised', now), actuationBannerVisible(a, now) && actuationBannerState(a, null).cancel != null);
  }
});

/* ── the shapes' words beside a standing write ──────────────────────────────────────────── */

const holdBase: HoldSummaryPlan = {
  requiredExtraKwh: 0, cushionShortfall: false, cushionTroughSocPct: 37.49, cushionLineSocPct: 31.13, cushionBasis: 'pack-close',
  minProjSocPct: 0, baselineMinSocPct: 0, reserveFloorPct: 16, cushionPct: 15,
};
const HOLDS: Array<[string, HoldSummaryPlan, { headline: string; detail: string; tone: string }]> = [
  ['the cushion holds', holdBase, {
    headline: 'No overnight charge needed.',
    detail: 'Even if the grid were lost overnight, the pack would close the charge window at ~37.5%, at or above the 31.1% floor+cushion line — nothing will be charged.',
    tone: 'ok',
  }],
  ['under the minimum buy', { ...holdBase, requiredExtraKwh: 0.4 }, {
    headline: 'No overnight charge tonight.',
    detail: 'The islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so nothing will be charged.',
    tone: 'ok',
  }],
  ['the window cannot cover the cushion', { ...holdBase, requiredExtraKwh: 30, cushionShortfall: true }, {
    headline: 'No overnight charge tonight — the window cannot cover the cushion.',
    detail: 'The outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing will be charged. '
      + 'Charge/pool limits prevent meeting the cushion — residual risk remains.',
    tone: 'warn',
  }],
  ['no window resolved', { ...holdBase, requiredExtraKwh: null }, {
    headline: 'No overnight charge tonight.', detail: 'No cheap charge window was resolved — nothing will be charged.', tone: 'muted',
  }],
];

test('★★★ a hold beside a standing write never says "nothing will be charged"; with none, every hold reads as before', () => {
  for (const [name, p, before] of HOLDS) {
    assert.deepEqual(holdSummary(p), before, `${name}: unchanged`);
    assert.deepEqual(holdSummary(p, { writeStands: false }), before, `${name}: unchanged`);
    const s = holdSummary(p, { writeStands: true });
    assert.equal(s.headline, WRITE_STANDS_HEADLINE, name);
    assert.equal(s.headline, 'The latest recompute would not charge — the armed write stands.');
    assert.equal(s.tone, 'warn', name);
    assert.ok(s.detail.endsWith(` ${WRITE_STANDS_NOTE}`), `${name}: ${s.detail}`);
    assert.equal(WRITE_STANDS_NOTE, 'A recompute never replaces the write armed with the announced plan; cancel it below.');
    assert.match(s.detail, /the latest recompute would charge nothing/, name);
    assert.doesNotMatch(`${s.headline} ${s.detail}`, /nothing will be charged|No overnight charge/i, name);
    // The hold's own reason is kept, word for word.
    assert.equal(s.detail, `${before.detail.replace('nothing will be charged', 'the latest recompute would charge nothing')} ${WRITE_STANDS_NOTE}`, name);
  }
});

test('★★ the unavailable-plan line says a standing write stands; with none it reads as before', () => {
  assert.equal(noPlanText(true, false), 'No plan tonight — forecast/telemetry basis incomplete; nothing will be charged.');
  assert.equal(noPlanText(false, false), 'No night-charge plan available — advisor idle or plan stale.');
  assert.equal(noPlanText(true, true), 'No fresh plan — forecast/telemetry basis incomplete. The write armed with the announced plan stands; cancel it below.');
  assert.equal(noPlanText(false, true), 'No fresh night-charge plan — advisor idle or plan stale. The write armed with the announced plan stands; cancel it below.');
  for (const b of [true, false]) assert.doesNotMatch(noPlanText(b, true), /nothing will be charged/);
});

/* ── the cancel's answer, and the cancel held for its own write ──────────────────────────── */

test('★★ the cancel\'s answer in the card\'s words: 2xx cancelled, 409 nothing to cancel, anything else retryable', () => {
  assert.deepEqual(cancelOutcome(200, { ok: true, actuation: { appliedAtMs: WIN_START + 60_000 } }),
    { ok: true, done: true, text: 'Cancelled — the applied write reverts within a minute.' });
  assert.deepEqual(cancelOutcome(200, { ok: true, actuation: { appliedAtMs: null } }), { ok: true, done: true, text: 'Cancelled — no write tonight.' });
  assert.deepEqual(cancelOutcome(200, null), { ok: true, done: true, text: 'Cancelled — no write tonight.' });
  // The route's two 409 answers (index.ts), word for word.
  assert.deepEqual(cancelOutcome(409, { ok: false, error: 'no supervised write is armed' }),
    { ok: false, done: true, text: 'Nothing to cancel — no supervised write is armed.' });
  assert.deepEqual(cancelOutcome(409, { ok: false, error: 'tonight’s write already completed and reverted' }),
    { ok: false, done: true, text: 'Nothing to cancel — tonight’s write already completed and reverted.' });
  for (const body of [null, 'x', { error: 5 }, { error: '' }, { error: 'x'.repeat(201) }]) {
    assert.deepEqual(cancelOutcome(409, body), { ok: false, done: true, text: 'Nothing to cancel — nothing is armed.' }, JSON.stringify(body));
  }
  // A failure keeps the button: the owner can try again.
  for (const st of [401, 403, 500, 502]) assert.deepEqual(cancelOutcome(st, { error: 'x' }), { ok: false, done: false, text: `cancel failed (HTTP ${st})` });
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const route = idx.slice(idx.indexOf("app.post('/api/night-charge/cancel'"), idx.indexOf('// v1.184.0 — the operator\'s "the grid is back"'));
  // v1.189.0 — the answers come from chargeCycle.cancelLeg (by leg), word for word; the route answers 409
  // with them and returns the leg it cancelled.
  const cyc = readFileSync(new URL('../src/chargeCycle.ts', import.meta.url), 'utf8');
  assert.match(cyc, /error: req === 'backup' \? 'no outage backup is armed' : 'no supervised write is armed'/);
  assert.match(cyc, /if \(s\.revertedAtMs != null\) return \{ ok: false, error: 'tonight’s write already completed and reverted' \};/);
  assert.match(route, /if \(!r\.ok\) \{\n\s+reply\.code\(409\);\n\s+return \{ ok: false, error: r\.error \};/);
  assert.match(route, /return \{ ok: true, actuation: s, leg: s\.leg, legs: cycleLegsStatus\(nightCycleView\(\), Date\.now\(\)\) \};/);
});

test('★★★ a confirmed cancel holds for its own write only — the next night\'s write keeps its Cancel', () => {
  const tonight = armed();
  const key = actuationKey(tonight);
  // v1.189.0 — keyed by its leg too: a record with none (an older server) is the cost leg.
  assert.equal(key, `2026-10-12|cost|${WIN_START}`);
  assert.equal(actuationKey(null), null);
  assert.equal(actuationKey(armed({ day: null })), null);
  assert.equal(actuationKey({ day: '2026-10-12' }), '2026-10-12|cost|-', 'no window on record');
  assert.equal(actuationKey({ day: '2026-10-12', leg: 'backup', windowStartMs: WIN_START }), `2026-10-12|backup|${WIN_START}`);
  // A cycle's two legs share a plan date: a cancel of one is not a cancel of the other.
  assert.equal(withConfirmedCancel({ ...armed(), leg: 'backup' }, key)!.cancelled, false);
  // The confirmed cancel shows at once, before the poll carries it…
  const shown = withConfirmedCancel(tonight, key)!;
  assert.equal(shown.cancelled, true);
  assert.equal(actuationBannerState(shown, null).cancel, null);
  assert.equal(writeStands(shown, 'supervised', NOW), false);
  assert.equal(tonight.cancelled, false, 'the status itself is not mutated');
  // …and a poll that left before the cancel, still reading it uncancelled, cannot undo it.
  assert.equal(withConfirmedCancel({ ...tonight }, key)!.cancelled, true);
  // The next evening's write — a card left open overnight — keeps its Cancel.
  const tomorrow = armed({ day: '2026-10-13', windowStartMs: WIN_START + 24 * H, windowEndMs: WIN_END + 24 * H });
  assert.equal(withConfirmedCancel(tomorrow, key), tomorrow);
  assert.equal(actuationBannerState(withConfirmedCancel(tomorrow, key)!, null).cancel, 'Cancel tonight');
  // The same plan date re-armed for another window (Saturday's arm for the Monday window) is another write.
  assert.equal(withConfirmedCancel(armed({ windowStartMs: WIN_START + 25 * H }), key)!.cancelled, false);
  assert.equal(withConfirmedCancel(tonight, null), tonight);
  assert.equal(withConfirmedCancel(null, key), null);
});

test('★★ R3: a reserve settled as someone else\'s offers no Cancel (the server answers 409); the cancel names its leg', () => {
  const settledAt = WIN_START + 2 * H;
  const foreign = applied({ foreignSettledAtMs: settledAt, foreignReservePct: 30 });
  assert.deepEqual(actuationBannerState(foreign, '23:00'), {
    text: 'The reserve was set to 30% outside the add-on — tonight\'s write no longer holds it.', settled: true, cancel: null,
  });
  // Ahead of an unconfirmed restore too: a value someone else set is not ours to restore.
  assert.equal(actuationBannerState({ ...foreign, revertedAtMs: WIN_END, revertRetries: 1 }, null).cancel, null);
  assert.equal(writeStands(foreign, 'supervised', settledAt + H), false, 'no write stands');
  assert.equal(actuationBannerVisible(foreign, settledAt + H), true);
  assert.equal(actuationBannerVisible(foreign, settledAt + COMPLETED_BANNER_MS), false, 'shown as long as a completed night');
  // The request: no body with no leg (the server cancels the cost leg — tonight's, with one leg).
  assert.deepEqual(cancelRequestInit(null), { method: 'POST' });
  assert.deepEqual(cancelRequestInit('backup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"leg":"backup"}' });
  assert.deepEqual(JSON.parse(cancelRequestInit('cost').body!), { leg: 'cost' });
});

/* ── the card's shapes (source: the card is not reachable from a unit test) ─────────────── */

/** The NightChargeCard component's body, and each JSX block it returns. */
function cardShapes(): { body: string; shapes: string[] } {
  const start = card.indexOf('export const NightChargeCard = memo(function NightChargeCard() {');
  const end = card.indexOf('\n});\n', start);
  assert.ok(start >= 0 && end > start, 'the card component is found');
  const body = card.slice(start, end);
  const lines = body.split('\n');
  const shapes: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)return \($/.exec(lines[i]);
    if (!m) continue;
    const close = lines.findIndex((l, j) => j > i && l === `${m[1]});`);
    assert.ok(close > i, `the return at line ${i} closes`);
    shapes.push(lines.slice(i, close + 1).join('\n'));
  }
  return { body, shapes };
}

test('★★★ every shape of the card renders a Cancel: the banner where the status is known, a status-blind Cancel where it is not', () => {
  const { body, shapes } = cardShapes();
  // Unavailable/loading, no fresh plan, hold, charge — and any shape added later.
  assert.equal(shapes.length, 4, 'four shapes');
  assert.doesNotMatch(body, /\breturn\s+</, 'every shape is a `return (` block the check can see');
  assert.doesNotMatch(body, /\breturn null\b/, 'no shape renders nothing');
  for (const s of shapes) {
    const cancels = (s.match(/\{banner\('m[tb]-3'\)\}|<StatusBlindCancel \/>/g) ?? []).length;
    assert.equal(cancels, 1, `one Cancel in:\n${s}`);
  }
  // The unavailable shape: no status, so no banner — the status-blind Cancel once the request failed.
  assert.match(shapes[0], /\{err && <StatusBlindCancel \/>\}/);
  // …and "Loading…" cannot hold: a request that has not answered in 15 s is a failure.
  assert.match(card, /\nconst STATUS_TIMEOUT_MS = 15_000;\n/);
  assert.match(card, /const ctl = new AbortController\(\);\n\s+const timer = window\.setTimeout\(\(\) => ctl\.abort\(\), STATUS_TIMEOUT_MS\);\n\s+try \{\n\s+const r = await fetch\(apiUrl\('api\/night-charge\/status'\), \{ signal: ctl\.signal \}\);/);
  assert.match(card, /\} finally \{\n\s+window\.clearTimeout\(timer\);\n\s+\}/);
  // The no-plan and hold shapes say a standing write stands.
  assert.match(card, /\n\s+const stands = writeStands\(actuation, status\.mode, Date\.now\(\)\);\n/);
  assert.match(shapes[1], /\{noPlanText\(plan != null && !plan\.basisComplete, stands\)\}<\/div>\n\s+\{banner\('mt-3'\)\}/);
  assert.match(card, /const hold = holdSummary\(plan, \{ writeStands: stands \}\);/);
  assert.match(shapes[2], /\{hold\.detail\}<\/div>\n\s+\{banner\('mt-3'\)\}\n\s+<AdvisoryNote mode=\{status\.mode\} \/>/);
  assert.match(shapes[3], /\n\s+\{banner\('mb-3'\)\}\n/);
});

test('★★★ the banner shows its Cancel whenever its state offers one, gated on nothing else, and holds a confirmed cancel per write', () => {
  const fn = card.slice(card.indexOf('function ActuationBanner('), card.indexOf('function StatusBlindCancel('));
  // Shown on writeStands' own conditions…
  assert.match(fn, /\n\s+if \(mode === 'advisory' \|\| !actuation \|\| !actuationBannerVisible\(actuation, Date\.now\(\)\)\) return null;\n/);
  // v1.191.0 (T16) — the deadline is formatted in the payload's site zone (hhmm = siteHHMM(status.siteTimeZone)).
  assert.match(fn, /const state = actuationBannerState\(actuation, hhmm\(actuation\.cancelDeadlineMs\)\);/);
  // …with the button on `state.cancel` alone.
  assert.match(fn, /\n\s+\{state\.cancel && <CancelButton label=\{state\.cancel\} busy=\{busy\} onClick=\{doCancel\} \/>\}\n/);
  assert.match(fn, /<span className=\{state\.settled \? 'text-muted' : 'text-warn'\}>\{state\.text\}<\/span>/);
  // v1.189.0 — for the banner's own leg (none from an older server: the server reads it as the cost leg).
  assert.match(fn, /const out = await postCancel\(actuation\.leg \?\? null\);\n\s+if \(out\.ok\) onCancelled\(\);\n\s+else setCancelErr\(out\.text\);/);
  // The card holds a confirmed cancel against its write (never an unkeyed flag that outlives the night).
  assert.match(card, /\n\s+const \[cancelledKey, setCancelledKey\] = useState<string \| null>\(null\);\n/);
  assert.match(card, /\n\s+const actuation = withConfirmedCancel\(status\.actuation \?\? null, cancelledKey\);\n\s+const onCancelled = \(\) => setCancelledKey\(actuationKey\(actuation\)\);\n/);
  assert.doesNotMatch(card, /localCancelled/);
  assert.doesNotMatch(card, /status\.actuation \?\? null\} onCancelled/, 'the banner reads the record with the confirmed cancel');
  // The status-blind Cancel: the same POST, its answer in the card's words, the button kept until a definitive one.
  const blind = card.slice(card.indexOf('function StatusBlindCancel('), card.indexOf('function CancelButton('));
  assert.match(blind, /setOut\(await postCancel\(\)\);/);
  assert.match(blind, /\{!out\?\.done && <CancelButton label="Cancel tonight" busy=\{busy\} onClick=\{doCancel\} \/>\}/);
  assert.match(card, /const r = await fetch\(apiUrl\('api\/night-charge\/cancel'\), cancelRequestInit\(leg\)\);\n\s+let body: unknown = null;\n\s+try \{ body = await r\.json\(\); \} catch \{[^}]*\}\n\s+return cancelOutcome\(r\.status, body\);/);
  // The pure rules live in one place.
  assert.match(web, /\nexport function actuationBannerState\(a: BannerTextActuation, deadline: string \| null\): BannerState \{\n/);
});

test('★★ the status route serves the actuation whatever the plan, so a shape with no plan still has its banner', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const route = idx.slice(idx.indexOf("app.get('/api/night-charge/status'"), idx.indexOf("app.post('/api/night-charge/cancel'"));
  assert.match(route, /\n\s+actuation: \{\n\s+\.\.\.nightActuationMem,\n\s+cancelDeadlineMs:\n/);
  assert.doesNotMatch(route, /actuation: plan/);
});
