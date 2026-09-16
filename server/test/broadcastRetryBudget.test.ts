import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrySlotDecision } from '../src/broadcast.js';

/**
 * v1.159.0 — the deferred-retry budget has to COUNT, or a failing announcement repeats forever.
 *
 * 2026-09-15: the panel's payload froze at 20:40, the critical went audible at 20:44, and
 * `music_assistant.play_announcement` then returned HTTP 500 ("Server got itself in trouble")
 * on every attempt. The log shows `deferred retry 1/3` at 20:47:12, 20:50:16 and 20:53:20 —
 * the SAME attempt number three times. The timer callback cleared `retryLevel` before
 * re-running the broadcast, and `scheduleBroadcastRetry` only sees a pending slot while
 * `retryLevel != null`, so every failure started a fresh budget: the retry never gave up and
 * re-announced roughly every 30 s plus call time. broadcast.ts's own single-flight comment
 * records that overlapping play_announcement calls are what wedges MA into those 500s, so the
 * loop can sustain the very failure it is retrying.
 */

const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

const MAX = 3;

test('★★★ a persistent failure exhausts the budget and gives up', () => {
  // The slot now survives the timer firing, so each failure sees the previous attempt.
  let pending: { level: 'red'; attempt: number } | null = null;
  const attempts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = retrySlotDecision(pending, 'red', MAX);
    if (d.action === 'give-up') { attempts.push(-1); break; }
    assert.equal(d.action, 'arm');
    attempts.push(d.attempt);
    pending = { level: 'red', attempt: d.attempt };
  }
  assert.deepEqual(attempts, [1, 2, 3, -1], 'arms 1, 2, 3 then gives up — never 1, 1, 1, …');
});

test('THE DEFECT: a slot cleared at fire time re-arms at attempt 1 forever', () => {
  // What production did before v1.159.0: pending was always null at the next failure.
  const attempts: number[] = [];
  for (let i = 0; i < 5; i++) attempts.push(retrySlotDecision(null, 'red', MAX).attempt);
  assert.deepEqual(attempts, [1, 1, 1, 1, 1], 'the 20:47/20:50/20:53 "deferred retry 1/3" shape');
});

test('a more severe condition still gets a fresh budget', () => {
  const d = retrySlotDecision({ level: 'yellow', attempt: 2 }, 'red', MAX);
  assert.deepEqual([d.action, d.attempt], ['arm', 1], 'yellow churn must not spend the red budget');
});

test('a pending severe retry is not superseded by a milder deferral', () => {
  const d = retrySlotDecision({ level: 'red', attempt: 1 }, 'yellow', MAX);
  assert.equal(d.action, 'keep-pending');
  assert.equal(d.attempt, 1, 'and it keeps its place in the budget');
});

test('★★★ the timer keeps the slot, and a broadcast with no retry pending releases it', () => {
  const code = src('broadcast.ts').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  // The fire path clears only the timer handle.
  const fire = code.indexOf('    retryTimer = setTimeout(() => {');
  assert.ok(fire > 0, 'the deferred-retry timer is located');
  const body = code.slice(fire, code.indexOf('}, delay);', fire));
  // The PROLOGUE — everything before the stopped-guard — must clear only the handle. The
  // disabled-cancel branch further down legitimately releases the slot, so scope the pin.
  const prologue = code.slice(fire, code.indexOf('if (stopped) return;', fire));
  assert.ok(prologue.includes('retryTimer = null;'), 'the handle is cleared');
  assert.ok(!prologue.includes('retryLevel = null;'),
    'the slot must survive the fire, or the budget restarts at 1 on every failure');
  assert.ok(body.includes("log('broadcast: deferred retry cancelled — broadcasts disabled');"),
    'an operator who disabled broadcasts still cancels the armed retry');
  const cancel = body.indexOf('deferred retry cancelled');
  assert.ok(body.slice(cancel, cancel + 200).includes('retryLevel = null;'),
    'and that cancel path DOES release the slot');

  // The slot is released exactly when nothing is armed.
  assert.ok(code.includes('  const releaseRetrySlotIfIdle = () => {\n    if (retryTimer == null) { retryAttempt = 0; retryLevel = null; }\n  };'),
    'release is guarded on there being no armed timer');
  const completion = code.indexOf("    lastOutcome = errors.length === 0 ? 'success' : 'partial';");
  assert.ok(completion > 0);
  const tail = code.slice(completion, completion + 400);
  assert.ok(tail.includes('releaseRetrySlotIfIdle();'), 'every completed broadcast releases an idle slot');
  assert.ok(tail.indexOf('releaseRetrySlotIfIdle();') < tail.indexOf('persistStatus();'),
    'released before the status is persisted');
});
