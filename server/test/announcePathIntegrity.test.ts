import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  nightChargeSpokenNotice, MAX_SPOKEN_ADVISORY_CHARS,
} from '../src/nightChargeActuator.js';
import {
  WAV_BYTES_PER_SEC, ANNOUNCE_TIMEOUT_FLOOR_MS, retrySlotDecision,
} from '../src/broadcast.js';

/**
 * v1.122.0 — the announce path. Four findings from the 2026-09-03 audit, all in
 * the one channel that reaches the household without a phone.
 */

/* ── #14 the nightly advisory held both alarm speakers for a full minute ──── */

const LIVE = {
  buyKwhRounded: 16,
  targetPct: 50,
  deadlineText: 'tonight at 10:55 PM',
  deadlineTextEs: 'esta noche a las 10:55 PM',
  cushionShortfall: true,   // pinned true on this plant — the worst case
};

test('THE DEFECT: the bilingual spoken advisory is bounded', () => {
  const { en, es } = nightChargeSpokenNotice(LIVE);
  const total = en.length + es.length;
  assert.ok(total <= MAX_SPOKEN_ADVISORY_CHARS,
    `bilingual advisory is ${total} chars, over the ${MAX_SPOKEN_ADVISORY_CHARS} bound`);
});

test('the bound keeps the clip well inside the announce timeout floor', () => {
  // The measured 2026-09-02 clip: 2,643,918 B at 44,100 B/s = 59.95 s for 801
  // chars of bilingual text. Scale that ratio to the bound.
  const MEASURED_BYTES = 2_643_918;
  const MEASURED_CHARS = 801;
  const { en, es } = nightChargeSpokenNotice(LIVE);
  const projectedBytes = MEASURED_BYTES * ((en.length + es.length) / MEASURED_CHARS);
  const projectedMs = (projectedBytes / WAV_BYTES_PER_SEC) * 1000;
  assert.ok(projectedMs < ANNOUNCE_TIMEOUT_FLOOR_MS * 0.6,
    `projected ${Math.round(projectedMs / 1000)}s should sit well under the ${ANNOUNCE_TIMEOUT_FLOOR_MS / 1000}s floor`);
  // And it must be a real improvement on what shipped.
  assert.ok(projectedMs < 40_000, `projected ${Math.round(projectedMs / 1000)}s vs the 60s that shipped`);
});

test('the shortfall disclosure survives — audible is never quieter than text', () => {
  const withIt = nightChargeSpokenNotice(LIVE);
  const without = nightChargeSpokenNotice({ ...LIVE, cushionShortfall: false });
  assert.match(withIt.en, /cushion not fully met/i);
  assert.match(withIt.es, /no cubierto por completo/i);
  assert.ok(!/cushion not fully met/i.test(without.en));
  assert.ok(without.en.length < withIt.en.length);
});

test('the advisory still carries what the listener must act on', () => {
  const { en, es } = nightChargeSpokenNotice(LIVE);
  for (const [label, t] of [['en', en], ['es', es]] as const) {
    assert.match(t, /16/, `${label}: how much`);
    assert.match(t, /50/, `${label}: to what reserve`);
    assert.match(t, /10:55/, `${label}: by when`);
    assert.match(t, /Power/, `${label}: how to cancel`);
  }
});

test('both languages are non-empty — a missing es plays ENGLISH TWICE (v1.67.0)', () => {
  const { en, es } = nightChargeSpokenNotice({ ...LIVE, cushionShortfall: false });
  assert.ok(en.length > 0 && es.length > 0);
});

/* ── #7, #4, #12 — structural guards on broadcast.ts ─────────────────────── */

const SRC = readFileSync(resolve(import.meta.dirname, '../src/broadcast.ts'), 'utf8');

/* Behavioural tests for the retry precedence — the HIGH finding. The three
 * source-scan guards further down cover WIRING only (that the pure decision is
 * actually reached, and that the other two fixes are connected); they are
 * structural lints in the moduleInitOrder.test.ts tradition, not behaviour. */

const MAX = 3;

test('THE INCIDENT (#7): a yellow deferral cannot erase a pending RED retry', () => {
  const pendingRed = { level: 'red' as const, attempt: 1 };
  const d = retrySlotDecision(pendingRed, 'yellow', MAX);
  assert.equal(d.action, 'keep-pending');
  assert.equal(d.attempt, 1, 'the red keeps its slot AND its place in the budget');
});

test('#7: a RED supersedes a pending yellow and gets a fresh budget', () => {
  const pendingYellow = { level: 'yellow' as const, attempt: 2 };
  const d = retrySlotDecision(pendingYellow, 'red', MAX);
  assert.equal(d.action, 'arm');
  assert.equal(d.attempt, 1, 'yellow churn must not have spent the red\'s retries');
});

test('#7: three yellow deferrals no longer starve the next red', () => {
  // The old shared counter: yellow, yellow, yellow -> attempt 3 -> the next red
  // hit "giving up after 3 deferred retries" with no attempt at all.
  let pending: { level: 'green' | 'yellow' | 'red'; attempt: number } | null = null;
  for (let i = 0; i < 3; i++) {
    const d = retrySlotDecision(pending, 'yellow', MAX);
    assert.equal(d.action, 'arm');
    pending = { level: 'yellow', attempt: d.attempt };
  }
  assert.equal(pending!.attempt, 3, 'yellow has exhausted its own budget');
  const red = retrySlotDecision(pending, 'red', MAX);
  assert.equal(red.action, 'arm', 'the red still gets to try');
  assert.equal(red.attempt, 1);
});

test('#7: same-level deferrals still consume the budget and then give up', () => {
  let pending: { level: 'red'; attempt: number } | null = null;
  for (let i = 1; i <= MAX; i++) {
    const d = retrySlotDecision(pending, 'red', MAX);
    assert.equal(d.action, 'arm');
    assert.equal(d.attempt, i);
    pending = { level: 'red', attempt: d.attempt };
  }
  const done = retrySlotDecision(pending, 'red', MAX);
  assert.equal(done.action, 'give-up', 'anti-thrash for a persistently failing level is unchanged');
});

test('#7: green never supersedes anything above it', () => {
  assert.equal(retrySlotDecision({ level: 'yellow', attempt: 1 }, 'green', MAX).action, 'keep-pending');
  assert.equal(retrySlotDecision({ level: 'red', attempt: 1 }, 'green', MAX).action, 'keep-pending');
  assert.equal(retrySlotDecision(null, 'green', MAX).action, 'arm', 'but an empty slot still takes it');
});

test('WIRING (#7): the monitor actually reaches the pure decision', () => {
  assert.match(SRC, /let retryLevel: ConditionLevel \| null = null;/,
    'the pending retry must remember which level it belongs to');
  assert.match(SRC, /const decision = retrySlotDecision\(pending, level, RETRY_DELAYS_MS\.length\);/,
    'scheduleBroadcastRetry must delegate to the tested pure decision');
});

test('#7: superseding a pending retry is no longer silent', () => {
  assert.match(SRC, /superseding the pending \$\{retryLevel \?\? '\?'\} retry/,
    'discarding a pending retry must be logged');
});

test('THE DEFECT (#4): the MA timeout returns ok WITHOUT verification credit', () => {
  assert.match(SRC, /return \{ ok: true, verified: false \};/,
    'a timed-out dispatch is "delivery UNKNOWN" — do not retry, but do not claim it was heard');
  assert.match(SRC, /const deliveryVerified = result\.ok && result\.verified !== false;/);
  assert.match(SRC, /isRecordableRedAnnounce\(level, deliveryVerified\)/,
    'the red replay gate must be credited on VERIFIED delivery, not merely on ok');
});

test('#4: a genuinely successful dispatch still earns verification', () => {
  assert.match(SRC, /if \(last\.ok\) return \{ ok: true, verified: true \};/);
});

test('THE DEFECT (#12): the consent notice bypasses the same-level storm gate', () => {
  assert.match(SRC, /opts\?: \{ consentNotice\?: boolean \}/,
    'announce() must accept a consent-notice flag');
  assert.match(SRC, /runBroadcast\(level, priority, message, opts\?\.consentNotice === true, messageEs\)/,
    'the flag must reach runBroadcast as bypassStormGate');
});

test('#12: the night-charge arm actually passes it', () => {
  const idx = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.match(idx, /broadcast\.announce\('medium', spoken, spokenEs, \{ consentNotice: true \}\)/,
    'the supervised arm is the consent checkpoint — it must not be storm-gated away');
});
