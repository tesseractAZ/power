/**
 * v1.187.20 — the host-pressure WARNING raises the audible condition only once host pressure
 * has stood for HOST_PRESSURE_WARN_DWELL_MS (default 300 s). It is on the card, and keeps its
 * push, from the first non-ok assessment.
 *
 * THE DEFECT (2026-10-10 22:33). A Home Assistant Core update on the same host pushed the load
 * over the warning line for 59 s (22:33:02.7 → 22:34:02.7). computeAlerts emitted
 * host-pressure-warn on the first non-ok assessment, conditionFromAlerts counted it, and a
 * yellow was spoken on the speakers and the cordless phone; the blip cleared while it was still
 * playing. Only the CRITICAL had a dwell (HOST_PRESSURE_CRIT_DWELL_MS, v1.45.0).
 *
 * The evidence for the default: 33 recorded warning episodes from 07-25 to 08-23 lasted
 * 60-256 s; 5 reach the critical's 180 s, none reaches 300 s.
 *
 * Driven through the REAL chain: selfVitals.tickAssess (reader overrides) → computeAlerts →
 * speakableAlerts → conditionFromAlerts, at the production cadences (vitals assessed every
 * 60 s, the alert tick every 20 s), on a controlled clock.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-hp-warn-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
delete process.env.HOST_PRESSURE_WARN_DWELL_S;
delete process.env.HOST_PRESSURE_CRIT_DWELL_S;

const {
  computeAlerts, hostPressureWarnAudible, hostPressureWarnDwellMsFrom, hostPressureDwellText,
  HOST_PRESSURE_WARN_DWELL_MS, HOST_PRESSURE_CRIT_DWELL_MS, HOST_PRESSURE_LATCH_CLEAR_MS, _resetHostPressureDwellForTest,
} = await import('../src/alerts.js');
const { ingestLagProbe, tickAssess, _resetVitalsForTest } = await import('../src/selfVitals.js');
const { conditionFromAlerts, speakableAlerts, CONDITION_CLEAR_DWELL_MS } = await import('../src/broadcast.js');
const { risingEdgePushes } = await import('../src/alertMonitor.js');

const SEC = 1_000;
const MIN = 60_000;
const WARN_D = HOST_PRESSURE_WARN_DWELL_MS;

/* ── clock: 2026-10-10 22:33:02.7 MST, the first non-ok assessment of the incident ── */
const T0 = Date.UTC(2026, 9, 11, 5, 33, 2, 700);
const realDateNow = Date.now;
let offsetMs = 0;
Date.now = () => T0 + offsetMs;
after(() => {
  Date.now = realDateNow;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  offsetMs = 0;
  _resetVitalsForTest();
  _resetHostPressureDwellForTest();
});

/** One vitals assessment at the current clock, with load1 as the only readable gauge
 *  (lag probe at 0 ms, memory and disk unreadable ⇒ null-honest 'ok'). */
function assess(load1: number): void {
  const now = Date.now();
  ingestLagProbe(0, now);
  tickAssess(now, { load: () => ({ load1, load5: load1 }), memAvailableMb: () => null, dataDiskFreeMb: () => null });
}

interface Tick { s: number; hp: Alert | undefined; level: 'green' | 'yellow' | 'red'; spoken: Alert[] }
/** The production cadences from `fromS` to `toS` inclusive: an assessment every 60 s (load from
 *  `loadAt`), the alert tick every 20 s. Each tick's host-pressure alert and the audible level the
 *  broadcast tick would derive from it (speakableAlerts → conditionFromAlerts). */
function run(fromS: number, toS: number, loadAt: (s: number) => number): Tick[] {
  const out: Tick[] = [];
  for (let s = fromS; s <= toS; s += 20) {
    offsetMs = s * SEC;
    if (s % 60 === 0) assess(loadAt(s));
    const hp = computeAlerts({}).filter((a) => a.id.startsWith('host-pressure-'));
    assert.ok(hp.length <= 1, 'one rolled host-pressure alert');
    const spoken = speakableAlerts(hp, Date.now(), () => undefined);
    out.push({ s, hp: hp[0], level: conditionFromAlerts(spoken).level, spoken });
  }
  return out;
}
const firstAt = (ticks: Tick[], level: string): number | undefined => ticks.find((t) => t.level === level)?.s;
const transitions = (ticks: Tick[]): string[] => {
  const out: string[] = [];
  let prev = 'green';
  for (const t of ticks) { if (t.level !== prev) out.push(`${prev}→${t.level}@${t.s}`); prev = t.level; }
  return out;
};

/* ══ the 10-10 incident ════════════════════════════════════════════════════════════════════ */

test('★★★ 10-10 replay: the 59 s Core-update blip is on the card at once and never raises the audible condition', () => {
  const ticks = run(0, 180, (s) => (s < 60 ? 4.2 : 0.8));
  const during = ticks.filter((t) => t.s < 60);
  assert.equal(during.length, 3, 'three alert ticks saw the blip');
  for (const t of during) {
    assert.ok(t.hp, `the warning is on the card at +${t.s} s`);
    assert.equal(t.hp.id, 'host-pressure-warn');
    assert.equal(t.hp.severity, 'warning');
    assert.equal(t.hp.audible, false, `★ not audible at +${t.s} s`);
    assert.match(t.hp.detail, /Not announced on the speakers unless the pressure lasts 5 min\./);
    assert.equal(t.level, 'green', `★ the audible condition stays green at +${t.s} s`);
    assert.deepEqual(t.spoken, [], 'nothing for the broadcast tick to voice');
    assert.equal(risingEdgePushes(t.hp), true, 'the push gate still owes it (Alert.audible is not a push gate)');
  }
  // Even the raw count (no speech pre-filter) leaves it out: the HA condition reads the same.
  assert.equal(conditionFromAlerts([during[0].hp!]).level, 'green');
  assert.ok(ticks.filter((t) => t.s >= 60).every((t) => t.hp == null && t.level === 'green'), 'cleared at 22:34:02.7');
  assert.deepEqual(transitions(ticks), [], 'no yellow at all');
});

test('★★★ pressure that stands 6 min raises ONE audible yellow, at the dwell, held until it clears', () => {
  // Pressure from 0 to 360 s, an ok assessment at 420 s.
  const ticks = run(0, 540, (s) => (s <= 360 ? 4.2 : 0.8));
  assert.equal(WARN_D, 5 * MIN, 'the default dwell is 5 minutes');
  assert.equal(firstAt(ticks, 'yellow'), 300, '★ the yellow is raised at the dwell, not before');
  for (const t of ticks.filter((x) => x.s < 300)) {
    assert.equal(t.hp?.audible, false, `held at +${t.s} s`);
    assert.equal(t.level, 'green');
  }
  for (const t of ticks.filter((x) => x.s >= 300 && x.s < 420)) {
    assert.equal(t.hp?.id, 'host-pressure-warn');
    assert.notEqual(t.hp?.audible, false, `audible at +${t.s} s`);
    assert.ok(!t.hp?.detail.includes('Not announced'), 'the card stops saying it is held');
    assert.equal(t.level, 'yellow', `★ no flapping at the boundary (+${t.s} s)`);
  }
  // One raise, one clear: the clear is the ordinary yellow → green the broadcast dwell confirms.
  assert.deepEqual(transitions(ticks), ['green→yellow@300', 'yellow→green@420']);
  // The counted warning keeps one identity from the raise to the clear (one announcement).
  const fps = new Set(ticks.filter((t) => t.level === 'yellow').map((t) => conditionFromAlerts(t.spoken).warningFingerprints.join('|')));
  assert.equal(fps.size, 1);
});

/* ══ the critical is unchanged ═════════════════════════════════════════════════════════════ */

test('★★★ the critical keeps its own 180 s dwell: red at 180 s, before the warning dwell, and never held', () => {
  assert.equal(HOST_PRESSURE_CRIT_DWELL_MS, 180_000);
  const ticks = run(0, 280, () => 7.0); // crit pressure throughout
  assert.equal(firstAt(ticks, 'red'), 180, '★ red after the crit dwell, not after the warning dwell');
  for (const t of ticks.filter((x) => x.s < 180)) {
    assert.equal(t.hp?.id, 'host-pressure-warn', 'inside the crit dwell it surfaces as the warning');
    assert.equal(t.hp?.audible, false, 'and that warning is not audible yet');
    assert.equal(t.level, 'green', `+${t.s} s`);
  }
  for (const t of ticks.filter((x) => x.s >= 180)) {
    assert.equal(t.hp?.id, 'host-pressure-crit');
    assert.equal(t.hp?.severity, 'critical');
    assert.notEqual(t.hp?.audible, false, '★ the critical is never held by the warning dwell');
    assert.equal(t.level, 'red');
  }
});

test('★★ a sustained critical that falls back to the warning goes red → yellow, never through green', () => {
  // Crit 0-180 s (red at 180), load 5.0 from 240 s: the crit clears its margin (< 5.5) and the
  // assessment steps down to warn, 60 s before the warning's own 300 s dwell would have elapsed.
  const ticks = run(0, 360, (s) => (s < 240 ? 7.0 : 5.0));
  assert.equal(ticks.find((t) => t.s === 240)?.hp?.id, 'host-pressure-warn');
  assert.deepEqual(transitions(ticks), ['green→red@180', 'red→yellow@240'],
    '★ the warning is audible at once after a sustained critical (no all-clear between them)');
});

test('★★ a crit spike that never sustains is as silent as a warning blip', () => {
  // Crit at 0 s, warn at 60 s, ok at 120 s.
  const ticks = run(0, 240, (s) => (s < 60 ? 7.0 : s < 120 ? 4.0 : 0.8));
  assert.equal(ticks.find((t) => t.s === 60)?.hp?.id, 'host-pressure-warn');
  assert.ok(ticks.filter((t) => t.s < 120).every((t) => t.hp != null && t.hp.audible === false));
  assert.deepEqual(transitions(ticks), [], 'no yellow, no red');
});

/* ══ the end of an episode ═════════════════════════════════════════════════════════════════ */

test('★★★ v1.187.20 (review): one ok assessment during sustained pressure does not end an audible episode — the warning is back audible at once', () => {
  // The review's sequence: pressure 0-360 s (yellow at 300), ONE ok assessment at 420 s, pressure
  // again from 480 s. Ended on that ok, the returning warning was held another 300 s
  // (green→yellow@780): the broadcast's held green stood its clear dwell under it and "All clear"
  // was spoken with the warning back on the card, then a second yellow.
  const ticks = run(0, 900, (s) => (s <= 360 || s >= 480 ? 4.2 : 0.8));
  assert.deepEqual(transitions(ticks), ['green→yellow@300', 'yellow→green@420', 'green→yellow@480'],
    '★ the dip is 60 s, inside the clear window: the warning is audible again the moment it returns');
  for (const t of ticks.filter((x) => x.s >= 480)) {
    assert.equal(t.hp?.id, 'host-pressure-warn');
    assert.notEqual(t.hp?.audible, false, `★ not held again at +${t.s} s`);
    assert.ok(!t.hp?.detail.includes('Not announced'), 'the card does not say it is held');
  }
  // One identity across the dip, so the broadcast's flicker guard reads the return as the same yellow.
  const fps = new Set(ticks.filter((t) => t.level === 'yellow').map((t) => conditionFromAlerts(t.spoken).warningFingerprints.join('|')));
  assert.equal(fps.size, 1);
});

test('★★★ v1.187.20 (review): an audible episode ends once ok has stood the clear window — a later episode then waits its own dwell', () => {
  // Episode 1: 0-360 s (yellow at 300); ok assessed at 420, 480, 540 and 600 s; the pass at 600 s
  // is 180 s into the ok, and ends it. Episode 2: from 660 s, held to 960 s.
  const ticks = run(0, 1020, (s) => (s <= 360 || s >= 660 ? 4.2 : 0.8));
  assert.deepEqual(transitions(ticks), ['green→yellow@300', 'yellow→green@420', 'green→yellow@960'],
    '★ the second episode is audible 300 s after ITS onset, not at once');
  for (const t of ticks.filter((x) => x.s >= 660 && x.s < 960)) {
    assert.equal(t.hp?.audible, false, `episode 2 held at +${t.s} s`);
  }
});

test('★★★ v1.187.20 (review): the latch clear window is the broadcast\'s clear dwell, measured from the first ok evaluation', () => {
  assert.equal(HOST_PRESSURE_LATCH_CLEAR_MS, CONDITION_CLEAR_DWELL_MS, 'the two cannot drift: the latch outlasts any dip the flicker guard absorbs');
  _resetHostPressureDwellForTest();
  hostPressureWarnAudible('warn', false, 0);
  assert.equal(hostPressureWarnAudible('warn', false, WARN_D), true, 'audible');
  const ok0 = WARN_D + 20 * SEC;
  assert.equal(hostPressureWarnAudible('ok', false, ok0), false, 'the first ok evaluation opens the window');
  assert.equal(hostPressureWarnAudible('ok', false, ok0 + HOST_PRESSURE_LATCH_CLEAR_MS - 1), false);
  assert.equal(hostPressureWarnAudible('warn', false, ok0 + HOST_PRESSURE_LATCH_CLEAR_MS - 1), true, '★ back 1 ms inside the window: audible at once');
  // The return closed the window: a new one opens at the next ok.
  const ok1 = ok0 + HOST_PRESSURE_LATCH_CLEAR_MS;
  assert.equal(hostPressureWarnAudible('ok', false, ok1), false);
  assert.equal(hostPressureWarnAudible('ok', false, ok1 + HOST_PRESSURE_LATCH_CLEAR_MS - 1), false);
  assert.equal(hostPressureWarnAudible('warn', false, ok1 + HOST_PRESSURE_LATCH_CLEAR_MS - 1), true, 'the window restarted at its own first ok');
  const ok2 = ok1 + 2 * HOST_PRESSURE_LATCH_CLEAR_MS;
  assert.equal(hostPressureWarnAudible('ok', false, ok2), false);
  assert.equal(hostPressureWarnAudible('ok', false, ok2 + HOST_PRESSURE_LATCH_CLEAR_MS), false, 'ok for the whole window: the episode ends');
  assert.equal(hostPressureWarnAudible('warn', false, ok2 + HOST_PRESSURE_LATCH_CLEAR_MS + 20 * SEC), false, '★ a new episode starts over');
});

test('★★★ an episode that never became audible still ends on the first ok: a blip after a blip is held again', () => {
  _resetHostPressureDwellForTest();
  assert.equal(hostPressureWarnAudible('warn', false, 0), false);
  assert.equal(hostPressureWarnAudible('warn', false, 240 * SEC), false);
  assert.equal(hostPressureWarnAudible('ok', false, 260 * SEC), false, 'one ok ends a held episode');
  assert.equal(hostPressureWarnAudible('warn', false, 280 * SEC), false, '★ not timed from the first blip');
  assert.equal(hostPressureWarnAudible('warn', false, 280 * SEC + WARN_D - 1), false);
  assert.equal(hostPressureWarnAudible('warn', false, 280 * SEC + WARN_D), true, 'its own dwell');
  // Through computeAlerts: a 240 s blip, one ok assessment, another 240 s blip — never audible.
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  const ticks = run(0, 600, (s) => (s < 240 || (s >= 300 && s < 540) ? 4.2 : 0.8));
  assert.deepEqual(transitions(ticks), [], 'two held blips, one ok between them: nothing audible');
});

test('★★ v1.187.20 (review): a sustained critical, a short ok, then crit again: the returning pressure is audible yellow at once, never green under a crit assessment', () => {
  // The review's critical sequence: crit 0-240 s (red at 180), ok at 300 and 360, crit from 420.
  // The crit dwell restarts at 420 (unchanged), so the returning pressure is the warning until 600;
  // ended on the first ok, it was HELD and the condition read green while the assessment was crit.
  const ticks = run(0, 660, (s) => (s <= 240 || s >= 420 ? 7.0 : 0.8));
  assert.deepEqual(transitions(ticks), ['green→red@180', 'red→green@300', 'green→yellow@420', 'yellow→red@600']);
  for (const t of ticks.filter((x) => x.s >= 420 && x.s < 600)) {
    assert.equal(t.hp?.id, 'host-pressure-warn', 'inside the restarted crit dwell');
    assert.notEqual(t.hp?.audible, false, `★ audible at +${t.s} s: the episode was latched by the sustained critical`);
  }
});

test('★★ the episode clock spans levels; an audible episode survives a short ok', () => {
  _resetHostPressureDwellForTest();
  assert.equal(hostPressureWarnAudible('crit', false, 0), false, 'a crit tick starts the episode');
  assert.equal(hostPressureWarnAudible('warn', false, 120 * SEC), false);
  assert.equal(hostPressureWarnAudible('warn', false, WARN_D - 1), false, 'inside the dwell');
  assert.equal(hostPressureWarnAudible('warn', false, WARN_D), true, 'audible at exactly the dwell');
  assert.equal(hostPressureWarnAudible('crit', false, WARN_D + 20 * SEC), true, 'latched across levels');
  assert.equal(hostPressureWarnAudible('ok', false, WARN_D + 40 * SEC), false, 'recovery begins');
  assert.equal(hostPressureWarnAudible('warn', false, WARN_D + 60 * SEC), true, '★ back after 20 s of ok: the same episode');
  assert.equal(hostPressureWarnAudible('ok', false, WARN_D + 80 * SEC), false);
  assert.equal(hostPressureWarnAudible('ok', false, WARN_D + 80 * SEC + HOST_PRESSURE_LATCH_CLEAR_MS), false, 'the recovery stood its window');
  assert.equal(hostPressureWarnAudible('warn', false, WARN_D + 100 * SEC + HOST_PRESSURE_LATCH_CLEAR_MS), false, '★ a new episode starts over');
});

test('★★ a sustained critical latches the warning audible for the rest of the episode', () => {
  _resetHostPressureDwellForTest();
  assert.equal(hostPressureWarnAudible('crit', false, 0), false);
  assert.equal(hostPressureWarnAudible('crit', true, 180 * SEC), true, 'the critical sustained');
  assert.equal(hostPressureWarnAudible('warn', false, 200 * SEC), true, '★ still audible after the step down');
  assert.equal(hostPressureWarnAudible('ok', false, 260 * SEC), false);
  assert.equal(hostPressureWarnAudible('warn', false, 280 * SEC), true, 'a 20 s dip: still the latched episode');
  assert.equal(hostPressureWarnAudible('ok', false, 300 * SEC), false);
  assert.equal(hostPressureWarnAudible('ok', false, 300 * SEC + HOST_PRESSURE_LATCH_CLEAR_MS), false);
  assert.equal(hostPressureWarnAudible('warn', false, 320 * SEC + HOST_PRESSURE_LATCH_CLEAR_MS), false, 'the latch went with the episode');
});

/* ══ the evidence and the configuration ════════════════════════════════════════════════════ */

test('★★ every recorded warning episode (07-25 to 08-23, 60-256 s) stays off the speakers; 5 min does not', () => {
  const recorded = [60000, 60000, 60000, 60000, 60001, 60001, 60001, 60001, 60001, 60001, 60001, 60001, 60001,
    60002, 60002, 60002, 60002, 60002, 60003, 60572, 62215, 116309, 119773, 119866, 119999, 123409, 165710,
    177968, 180000, 188196, 199507, 202385, 256212];
  assert.equal(recorded.length, 33);
  assert.equal(recorded.filter((d) => d >= HOST_PRESSURE_CRIT_DWELL_MS).length, 5, 'five reach 180 s: the crit dwell would not do');
  for (const d of [...recorded, 59_999]) {
    _resetHostPressureDwellForTest();
    let audible = false;
    for (let t = 0; t < d; t += 20 * SEC) audible ||= hostPressureWarnAudible('warn', false, t);
    hostPressureWarnAudible('ok', false, d);
    assert.equal(audible, false, `a ${Math.round(d / 1000)} s episode is not announced`);
  }
  _resetHostPressureDwellForTest();
  let at: number | null = null;
  for (let t = 0; t <= 6 * MIN && at == null; t += 20 * SEC) if (hostPressureWarnAudible('warn', false, t)) at = t;
  assert.equal(at, 5 * MIN, 'a 6-minute episode is announced at 5 minutes');
});

test('★ HOST_PRESSURE_WARN_DWELL_S: 0-900 s, anything else (empty included) is the 300 s default', () => {
  assert.equal(hostPressureWarnDwellMsFrom(undefined), 300_000);
  assert.equal(hostPressureWarnDwellMsFrom(''), 300_000, '★ an empty option is unset, not 0');
  assert.equal(hostPressureWarnDwellMsFrom('  '), 300_000);
  assert.equal(hostPressureWarnDwellMsFrom('abc'), 300_000);
  assert.equal(hostPressureWarnDwellMsFrom('-1'), 300_000);
  assert.equal(hostPressureWarnDwellMsFrom('901'), 300_000);
  assert.equal(hostPressureWarnDwellMsFrom('0'), 0, '0 = audible at once (the pre-v1.187.20 behaviour)');
  assert.equal(hostPressureWarnDwellMsFrom('120'), 120_000);
  assert.equal(hostPressureWarnDwellMsFrom('900'), 900_000);
  assert.equal(hostPressureDwellText(300_000), '5 min');
  assert.equal(hostPressureDwellText(90_000), '90 s');
});

test('★ v1.187.20 review — at critical level the held warning names the critical dwell (the red is announced sooner)', () => {
  const ticks = run(0, 60, () => 9.0); // load ≥ VITALS_LOAD_CRIT: a crit assessment, not yet sustained
  const first = ticks[0];
  assert.ok(first.hp, 'the rolled host-pressure alert is on the card');
  assert.equal(first.hp.id, 'host-pressure-warn', 'still the warning until the critical dwell elapses');
  assert.match(first.hp.detail, /Not announced on the speakers unless the pressure lasts 3 min\./);
  assert.doesNotMatch(first.hp.detail, /lasts 5 min/);
});
