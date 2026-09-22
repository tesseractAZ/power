import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideBlindRemediation, blindRemediationStep, setBlindRemediationHooks, resetBlindRemediation,
  freshBlindRemediationState, BLIND_REMEDIATION_VERIFY_MS, type BlindRemediationState,
} from '../src/blindRemediation.js';
import {
  canRemediateNow, recordRemediationHeal, BLIND_REMEDIATION_MIN_GAP_MS, HEAL_BUDGET_WINDOW_MS,
  type SelfHealState,
} from '../src/sessionSelfHeal.js';
import { silentCriticalEdges } from '../src/alertMonitor.js';
import { TELEMETRY_BLIND_ALERT_ID } from '../src/telemetryBlind.js';
import { allClearSpeechBlocked } from '../src/broadcast.js';

/**
 * v1.166.0 — REMEDIATE FIRST, ALARM ONLY IF IT FAILS (owner decision, 2026-09-17).
 *
 * 2026-09-17, on-peak: the EcoFlow cloud replayed a stale SHP2 shadow at 16:27:48, the
 * telemetry-blind CRITICAL spoke at 16:32, and the MQTT rebuild that fixed it in two
 * minutes did not start until 16:47:48 — the healer's 20-minute dwell. The owner's rule:
 * the alarm sounds only once an IMMEDIATE remediation has been tried and has failed.
 */

const M = 60_000;
const T0 = Date.UTC(2026, 8, 17, 23, 27, 48); // 16:27:48 MST

const step = (s: BlindRemediationState, t: number, blindActive: boolean, healAvailable = true) =>
  decideBlindRemediation(s, t, { blindActive, healAvailable });

/* ══ the decision ═════════════════════════════════════════════════════════ */

test('★★★ the 2026-09-17 incident, replayed: remediated at once, held, cleared — never sounded', () => {
  let s = freshBlindRemediationState();
  const first = step(s, T0, true);
  assert.equal(first.triggerHeal, true, 'the MQTT rebuild fires IMMEDIATELY — not after a 20-minute dwell');
  assert.equal(first.hold, true, 'and the alarm is held while it works');
  s = first.next;
  // The live rebuild restored a moving payload within ~2 min.
  for (let t = T0 + M; t < T0 + 2 * M; t += M) {
    const d = step(s, t, true);
    assert.equal(d.hold, true, 'held throughout the verify window');
    assert.equal(d.triggerHeal, false, 'one remediation per episode — never re-fired');
    s = d.next;
  }
  const back = step(s, T0 + 2 * M, false);
  assert.equal(back.phase, 'idle');
  assert.equal(back.hold, false);
});

test('★★★ remediation that FAILS releases the alarm at the deadline — the hold cannot be extended', () => {
  let s = step(freshBlindRemediationState(), T0, true).next;
  assert.equal(step(s, T0 + BLIND_REMEDIATION_VERIFY_MS - 1, true).hold, true);
  const due = step(s, T0 + BLIND_REMEDIATION_VERIFY_MS, true);
  assert.equal(due.hold, false, 'still blind at the deadline: the remediation failed — ALARM');
  assert.equal(due.phase, 'failed');
  s = due.next;
  const later = step(s, T0 + 60 * M, true);
  assert.equal(later.hold, false, 'a persisting episode is never re-held');
  assert.equal(later.triggerHeal, false, 'and never re-remediated inside the same episode');
});

test('★★★ no remediation available ⇒ alarm IMMEDIATELY — there is nothing to wait for', () => {
  const d = step(freshBlindRemediationState(), T0, true, false);
  assert.equal(d.hold, false, 'heal budget spent, or the last heal did not hold: sound now, as before');
  assert.equal(d.triggerHeal, false);
  assert.equal(d.phase, 'unavailable');
  assert.equal(step(d.next, T0 + M, true, true).hold, false,
    'budget freeing up mid-episode does not start a late hold on an alarm already sounding');
});

test('a cleared episode resets, so the NEXT one gets its own remediation', () => {
  let s = step(freshBlindRemediationState(), T0, true).next;
  s = step(s, T0 + 2 * M, false).next;
  const again = step(s, T0 + 30 * M, true);
  assert.equal(again.triggerHeal, true);
  assert.equal(again.hold, true);
});

/* ══ the integration step ═════════════════════════════════════════════════ */

test('★★ fail toward SOUNDING: no hooks, or a remedy that cannot start, never holds', () => {
  const logs: string[] = [];
  resetBlindRemediation();
  setBlindRemediationHooks(null);
  assert.equal(blindRemediationStep(T0, true, (m) => logs.push(m)).hold, false, 'no remediation registered');

  resetBlindRemediation();
  setBlindRemediationHooks({ canHeal: () => true, heal: () => { throw new Error('mqtt stop threw'); } });
  const r = blindRemediationStep(T0, true, (m) => logs.push(m));
  assert.equal(r.hold, false, 'the remedy could not even start — sound now');
  assert.ok(logs.some((l) => l.includes('remediation failed to start')));

  resetBlindRemediation();
  setBlindRemediationHooks({ canHeal: () => { throw new Error('boom'); }, heal: () => {} });
  assert.equal(blindRemediationStep(T0, true, () => {}).hold, false, 'an unanswerable canHeal is "unavailable"');
  setBlindRemediationHooks(null);
  resetBlindRemediation();
});

test('★★ every phase is logged — "held" and "never sounded" must be visible, not silent', () => {
  const logs: string[] = [];
  let heals = 0;
  resetBlindRemediation();
  setBlindRemediationHooks({ canHeal: () => true, heal: () => { heals++; } });
  assert.equal(blindRemediationStep(T0, true, (m) => logs.push(m)).hold, true);
  assert.equal(heals, 1);
  blindRemediationStep(T0 + M, true, (m) => logs.push(m));
  blindRemediationStep(T0 + 2 * M, false, (m) => logs.push(m));
  assert.ok(logs.some((l) => l.includes('remediating FIRST')));
  assert.ok(logs.some((l) => l.includes('RESTORED by the remediation — the alarm never sounded')));
  assert.equal(logs.length, 2, 'one line per phase change, not per tick');

  logs.length = 0;
  blindRemediationStep(T0 + 10 * M, true, (m) => logs.push(m));
  blindRemediationStep(T0 + 10 * M + BLIND_REMEDIATION_VERIFY_MS, true, (m) => logs.push(m));
  assert.ok(logs.some((l) => l.includes('did NOT restore telemetry') && l.includes('releasing the alarm')));
  setBlindRemediationHooks(null);
  resetBlindRemediation();
});

/* ══ the shared heal budget ═══════════════════════════════════════════════ */

const heals = (...ago: number[]): SelfHealState =>
  ({ starvedSinceMs: null, lastHealMs: ago.length ? T0 - Math.min(...ago) : null, healTimesMs: ago.map((a) => T0 - a) } as SelfHealState);

test('★★ remediation shares the rolling-24h budget and needs its 15-minute gap', () => {
  assert.equal(canRemediateNow(heals(), T0), true);
  assert.equal(canRemediateNow(heals(BLIND_REMEDIATION_MIN_GAP_MS - 1), T0), false,
    'a heal under 15 min ago means the last remedy did not hold — that is a failure: alarm now');
  assert.equal(canRemediateNow(heals(BLIND_REMEDIATION_MIN_GAP_MS), T0), true);
  const six = heals(1 * 60 * M, 2 * 60 * M, 3 * 60 * M, 4 * 60 * M, 5 * 60 * M, 6 * 60 * M);
  assert.equal(canRemediateNow(six, T0), false, 'the shared cap: the two healers together never exceed six a day');
  const aged = heals(HEAL_BUDGET_WINDOW_MS + 1, 2 * 60 * M, 3 * 60 * M, 4 * 60 * M, 5 * 60 * M, 6 * 60 * M);
  assert.equal(canRemediateNow(aged, T0), true, 'only heals inside the rolling 24 h count');
});

test('a remediation is booked exactly like a self-heal (budget, cooldown, onset reset)', () => {
  const s = { starvedSinceMs: T0 - 5 * M, lastHealMs: null, healTimesMs: [] } as SelfHealState;
  recordRemediationHeal(s, T0);
  assert.equal(s.lastHealMs, T0);
  assert.deepEqual(s.healTimesMs, [T0]);
  assert.equal(s.starvedSinceMs, null);
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ════════ */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ the remediation is registered, books the SHARED budget, and persists it BEFORE rebuilding', () => {
  const reg = INDEX.indexOf('setBlindRemediationHooks({');
  assert.ok(reg > 0, 'the hooks are registered');
  const body = INDEX.slice(reg, INDEX.indexOf('});', reg));
  assert.ok(body.includes('canHeal: () => canRemediateNow(selfHealState, Date.now())'));
  const book = body.indexOf('recordRemediationHeal(selfHealState, now);');
  const save = body.indexOf('saveSelfHealState(selfHealState);');
  const rebuild = body.indexOf('rebuildMqttSession();');
  assert.ok(book > 0 && save > book && rebuild > save,
    'book, persist, THEN rebuild — a crash mid-rebuild must not hand back a free heal');
});

test('★★ ONE rebuild implementation — the rate-floor healer uses it too', () => {
  const fn = INDEX.indexOf('function rebuildMqttSession(): void {');
  assert.ok(fn > 0);
  assert.equal(INDEX.split('void startMqttWithRetry();').length - 1, 1,
    'the stop/start pair exists once — inside rebuildMqttSession');
  const heal = INDEX.indexOf('if (healVerdict.heal) {');
  assert.ok(INDEX.slice(heal, INDEX.indexOf('}', INDEX.indexOf('rebuildMqttSession();', heal))).includes('rebuildMqttSession();'));
});

/* ══ "chose not to" vs "broke" — silent criticals by policy ═══════════════ */

test('★★ a critical held silent BY POLICY is announced once per episode', () => {
  const logged = new Set<string>();
  const spare = { id: 'dpu-err-X', severity: 'critical', annunciate: false as const, title: 'Core 4 error' };
  const warn = { id: 'w', severity: 'warning', annunciate: false as const, title: 'w' };
  const loud = { id: 'c', severity: 'critical', title: 'c' };
  const blind = { id: TELEMETRY_BLIND_ALERT_ID, severity: 'critical', annunciate: false as const, title: 'b' };
  assert.deepEqual(silentCriticalEdges(logged, [spare, warn, loud, blind]).map((a) => a.id), ['dpu-err-X'],
    'criticals only; the blind hold logs its own phases');
  assert.deepEqual(silentCriticalEdges(logged, [spare]), [], 'once per episode, not per tick');
  assert.deepEqual(silentCriticalEdges(logged, []), [], 'it clears…');
  assert.deepEqual(silentCriticalEdges(logged, [spare]).map((a) => a.id), ['dpu-err-X'], '…and a return is announced again');
});

/* ══ pre-merge review fixes ═══════════════════════════════════════════════ */

test('★★★ "All clear" is NEVER spoken while the blind alert is held — held is not cleared', () => {
  // Review finding: the hold sets annunciate=false, and the v1.17.0 all-clear speech gate
  // skipped annunciate=false criticals — so a warning clearing during the hold could say
  // "All clear. All stations report normal." while the system was blind.
  const held = { id: TELEMETRY_BLIND_ALERT_ID, severity: 'critical' as const, annunciate: false as const };
  assert.equal(allClearSpeechBlocked([held]), true, 'the held blind alert blocks the all-clear');
  const loud = { id: 'soc-low-x', severity: 'critical' as const };
  assert.equal(allClearSpeechBlocked([loud]), true, 'an ordinary critical still blocks it (v1.17.0)');
  const spare = { id: 'dpu-err-spare', severity: 'critical' as const, annunciate: false as const };
  assert.equal(allClearSpeechBlocked([spare]), false, 'a critical muted by POLICY still does not — unchanged');
  assert.equal(allClearSpeechBlocked([{ id: 'w', severity: 'warning' as const }]), false);
  assert.equal(allClearSpeechBlocked([]), false);
});

test('★★ the all-clear gate is the extracted predicate, in the speech path', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/broadcast.ts'), 'utf8');
  assert.ok(src.includes("if (level === 'green' && allClearSpeechBlocked(alerts)) {"));
});

test('★★ the hold deadline and the minimum gap are PINNED — "at most 5 minutes" is a promise', () => {
  // Review finding: nothing pinned these; VERIFY at 50 min or GAP at 0 passed the suite.
  assert.equal(BLIND_REMEDIATION_VERIFY_MS, 5 * 60_000, 'the owner is told the alarm is held at most 5 min');
  assert.equal(BLIND_REMEDIATION_MIN_GAP_MS, 15 * 60_000);
  const s = decideBlindRemediation(freshBlindRemediationState(), T0, { blindActive: true, healAvailable: true }).next;
  assert.equal(decideBlindRemediation(s, T0 + 5 * M - 1, { blindActive: true, healAvailable: true }).hold, true);
  assert.equal(decideBlindRemediation(s, T0 + 5 * M, { blindActive: true, healAvailable: true }).hold, false,
    'released at exactly 5 minutes, by the literal clock');
});

/* ══ v1.173.0 — the rate-collapse warning never SPEAKS (remediate first) ══ */

import { conditionFromAlerts } from '../src/broadcast.js';

test('★★★ a message-rate collapse warning does not raise the spoken condition — it pushes, the blind alarm speaks', () => {
  // 2026-09-21 18:13: a cloud stale-shadow episode; msg-rate-floor fired at the onset and was
  // SPOKEN as a yellow ~4 min before the telemetry-blind alarm could even start the rebuild.
  const rate = { id: 'msg-rate-floor-SHP2', severity: 'warning', title: 'Device barely reporting (rate collapse)', category: 'Connectivity' } as any;
  assert.equal(conditionFromAlerts([rate]).level, 'green', 'no yellow from the rate-collapse warning alone');
  assert.equal(rate.annunciate, undefined, 'annunciate stays unset, so its push and card still go');
  const other = { id: 'soc-low-X-1', severity: 'warning', title: 'x', category: 'Battery' } as any;
  assert.equal(conditionFromAlerts([rate, other]).level, 'yellow', 'every other warning still counts');
});
