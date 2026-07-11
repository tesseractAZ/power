import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BATTERY_SOC_THRESHOLDS,
  createBatterySocAlarm,
  socAlarmMessage,
  activeSocBand,
  socAlertSeverity,
  type SocThreshold,
} from '../src/batterySocAlarm.js';
import { socGridCrossDecision, reEscalateGridDrop } from '../src/socGridDispatch.js';
import type { AlarmPriority } from '../src/alertPriority.js';

// v0.12.0 — Unit tests for the backup-pool SoC audible alarm. Each test uses a
// UNIQUE tmp statePath so the persisted armed-map / lastSoc never leaks between
// cases (the alarm boot-arms from /data on construction). We collect the paths
// and best-effort remove them at the end.
const tmpPaths: string[] = [];
let seq = 0;
function makeAlarm(onCross: (t: SocThreshold) => void) {
  const statePath = join(tmpdir(), `soc-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(statePath);
  // v0.75.0 — onCross now fires per crossed band with an isPrimary flag; this helper
  // records only the ANNOUNCED (most-severe) band, so `fired` reflects what the operator
  // actually hears (the audible collapse). The per-band firing itself is asserted directly
  // by the "onCross fires for EVERY crossed band" test below.
  return createBatterySocAlarm({ onCross: (t, isPrimary) => { if (isPrimary) onCross(t); }, statePath });
}

test('BATTERY_SOC_THRESHOLDS — pcts and escalating priorities', () => {
  assert.deepEqual(
    BATTERY_SOC_THRESHOLDS.map((t) => t.pct),
    [50, 40, 30, 20, 15, 10, 8, 4, 2],
  );
  assert.deepEqual(
    BATTERY_SOC_THRESHOLDS.map((t) => t.priority),
    // audit #24 — 10 %/8 % promoted 'high'→'critical' to match alerts.ts's
    // reserve-floor classifier at the default 15 % reserve (both below floor, off-grid).
    ['low', 'low', 'low', 'medium', 'medium', 'critical', 'critical', 'critical', 'critical'],
  );
});

test('v0.14.0 — 50% advisory fires on a downward crossing (booted above 50)', () => {
  const fired: { pct: number; priority: string }[] = [];
  const alarm = makeAlarm((t) => fired.push({ pct: t.pct, priority: t.priority }));
  alarm.update(60); // boot above 50 → 50 is armed
  alarm.update(49); // cross down through 50 only
  assert.deepEqual(fired, [{ pct: 50, priority: 'low' }]);
  // Booting AT 49 must NOT retroactively fire 50.
  const fired2: number[] = [];
  const alarm2 = makeAlarm((t) => fired2.push(t.pct));
  alarm2.update(49);
  assert.deepEqual(fired2, []);
});

test('fresh alarm — only the 40 threshold crossed, no re-fire on repeat', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // First reading arms all (50 is above every threshold).
  alarm.update(50);
  // Down to 35: crosses only 40 (35 is still above 30).
  alarm.update(35);
  assert.deepEqual(fired, [40]);
  // Same reading again: edge-triggered, so no new fire.
  alarm.update(35);
  assert.deepEqual(fired, [40]);
});

test('boot-arming — first reading below thresholds must NOT re-announce', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // FIRST reading is 18: 40/30/20 are already below current SoC and must not
  // fire on boot — they are simply disarmed since we booted under them.
  alarm.update(18);
  assert.deepEqual(fired, []);
});

test('crossing deep — collapses to the worst band (4) but not 2 when landing at 3', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // v0.54.4 — a 47-pt fall in one tick is implausible from a FRESH baseline (the
  // single-tick plausibility guard would treat it as a stale-reconnect artifact). Here we
  // exercise the deep crossing against a STALE baseline (>10 min apart), which the guard
  // intentionally allows (a large change after a long gap is real).
  alarm.update(50, 0); // arms all
  alarm.update(3, 11 * 60 * 1000); // crosses 40/30/20/15/10/8/4 in ONE tick (not 2: 3 > 2)
  // v0.75.0 — collapsed to the single most-severe band crossed (4%, critical). The critical
  // alarm is still announced (never suppressed); 2 still does NOT fire because 3 > 2.
  assert.deepEqual(fired, [4]);
});

test('hysteresis — a value hovering on a boundary does not re-arm/chatter', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // v0.54.4 — stale baseline (>10 min) so the 50→19 deep crossing is honored (the plausibility
  // guard only suppresses a big fall from a FRESH baseline). The subsequent small moves are
  // within the cap so they pass regardless.
  const t0 = 11 * 60 * 1000;
  alarm.update(50, 0); // arms all
  alarm.update(19, t0); // crosses 40, 30, 20 in one tick → v0.75.0 collapses to the worst (20)
  assert.deepEqual(fired, [20]);
  // +1 over the 20 boundary is NOT enough hysteresis to re-arm 20.
  alarm.update(21, t0 + 1000);
  assert.deepEqual(fired, [20]);
  // +2 over the boundary DOES re-arm 20.
  alarm.update(22, t0 + 2000);
  // Back below 20 → 20 fires again (the re-arm/hysteresis behaviour is unchanged by collapse).
  alarm.update(19, t0 + 3000);
  assert.deepEqual(fired, [20, 20]);
});

test('activeSocBand — lowest threshold currently crossed', () => {
  assert.equal(activeSocBand(51), null); // above the top threshold (now 50)
  assert.equal(activeSocBand(50)?.pct, 50); // 50 ≤ 50 → the new top band
  assert.equal(activeSocBand(45)?.pct, 50); // 45 ≤ 50, > 40
  assert.equal(activeSocBand(18)?.pct, 20); // 18 ≤ 20, > 15
  assert.equal(activeSocBand(1)?.pct, 2); // 1 ≤ 2 (the lowest band)
});

test('socAlertSeverity — derives the (severity, source, priority) for each priority', () => {
  // v0.44.0 — these are REAL measured crossings: always source='threshold', and
  // the ISA tier is carried in the explicit `priority` field (Medium no longer
  // fakes source='learned').
  assert.deepEqual(socAlertSeverity('medium'), {
    severity: 'warning',
    source: 'threshold',
    priority: 'medium',
  });
  assert.equal(socAlertSeverity('high').source, 'threshold');
  assert.equal(socAlertSeverity('high').priority, 'high');
  assert.equal(socAlertSeverity('critical').severity, 'critical');
  assert.equal(socAlertSeverity('critical').source, 'threshold');
  assert.equal(socAlertSeverity('low').severity, 'info');
  assert.equal(socAlertSeverity('low').priority, 'low');
  // Every tier must be source='threshold' now — none route to the Predictive page.
  for (const p of ['critical', 'high', 'medium', 'low'] as const) {
    assert.equal(socAlertSeverity(p).source, 'threshold');
  }
});

test('socAlarmMessage — speaks the pct and band', () => {
  assert.ok(
    socAlarmMessage({ pct: 20, priority: 'medium' }).includes('Backup pool at 20 percent'),
  );
});

/* ─── v0.54.4 — single-tick plausibility guard (transient SoC=0 on SHP2 reconnect) ─── */

const MIN = 60_000;

test('v0.54.4 — a transient SoC=0 from a healthy fresh baseline does NOT ladder the cascade', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0); // boot healthy → arms every threshold
  alarm.update(0, 1 * MIN); // 63→0 in one 60s tick = the 2026-06-21 18:12 reconnect artifact
  assert.deepEqual(fired, [], 'an implausible single-tick collapse must be ignored, not announced');
  alarm.update(63, 2 * MIN); // pool was fine all along → recovers, still nothing fires
  assert.deepEqual(fired, []);
});

test('v0.54.4 — a SUSTAINED stale 0 keeps being ignored (baseline never poisoned)', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0);
  alarm.update(0, 1 * MIN); // ignored
  alarm.update(0, 2 * MIN); // still ignored — lastSoc stayed 63, so still a >25 drop
  alarm.update(0, 3 * MIN);
  assert.deepEqual(fired, []);
});

test('v0.54.4 — a genuine gradual discharge still fires every band once', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // Each step is well under the 25-pt cap → the guard never engages; the ladder fires normally.
  alarm.update(63, 0); // boot, arms all (no fire)
  alarm.update(45, 1 * MIN); // ↓ crosses 50
  alarm.update(35, 2 * MIN); // ↓ crosses 40
  alarm.update(28, 3 * MIN); // ↓ crosses 30
  alarm.update(18, 4 * MIN); // ↓ crosses 20
  alarm.update(13, 5 * MIN); // ↓ crosses 15
  alarm.update(9, 6 * MIN); // ↓ crosses 10 (baseline now <30 — guard inactive anyway)
  alarm.update(7, 7 * MIN); // ↓ crosses 8
  alarm.update(3, 8 * MIN); // ↓ crosses 4
  alarm.update(1, 9 * MIN); // ↓ crosses 2
  assert.deepEqual(fired, [50, 40, 30, 20, 15, 10, 8, 4, 2]);
});

test('v0.54.4/v0.75.0 — a real deep discharge that reaches 0 from a LOW baseline still fires critical (collapsed to the worst band)', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(12, 0); // boot already low (<30) → 50..15 disarmed, 10/8/4/2 armed
  alarm.update(0, 1 * MIN); // 12→0 in one tick: guard inactive (baseline <30); crosses 10/8/4/2
  // v0.75.0 — the same-tick multi-band crossing collapses to ONE announce for the most-severe
  // band (2%, critical). The critical alarm still fires — collapse never suppresses it.
  assert.deepEqual(fired, [2]);
});

test('v0.54.4/v0.75.0 — after a long gap (stale baseline) a large real change re-baselines and announces the worst band, not suppressed', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0); // boot healthy
  // 25 min later (add-on down / SHP2 offline) the pool genuinely sits at 20 — a real 43-pt
  // change, plausible across the gap (stale baseline → guard inactive). Crosses 50/40/30/20.
  // v0.75.0 — collapsed to the most-severe band crossed (20%): the alarm IS announced (not
  // suppressed), once, instead of laddering 50/40/30/20.
  alarm.update(20, 25 * MIN);
  assert.deepEqual(fired, [20]);
});

test('v0.54.4 — throttled persist keeps the slew guard active across a quick restart', () => {
  const sp = join(tmpdir(), `soc-restart-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(sp);
  // Run quietly at 63% for a while: no crossings, but the throttle persists the baseline so the
  // on-disk lastSocAtMs stays fresh (without it, only the boot persist @ t=0 would survive).
  const a1 = createBatterySocAlarm({ onCross: () => {}, statePath: sp });
  a1.update(63, 0); // boot → persist baseline @ 0
  a1.update(63, 6 * MIN); // quiet, >5min since persist → throttled persist @ 6min
  a1.update(63, 12 * MIN); // quiet → throttled persist @ 12min
  // "Restart": a fresh instance loads the persisted state (baseline ≈ 12min old at t=13min → fresh).
  const fired: number[] = [];
  const a2 = createBatterySocAlarm({ onCross: (t) => fired.push(t.pct), statePath: sp });
  a2.update(0, 13 * MIN); // transient 0 right after restart — guard still active (baseline 1min old)
  assert.deepEqual(fired, [], 'a quick restart must not re-open the cascade — throttled persist kept the baseline fresh');
});

/* ── v0.75.0 — same-tick multi-band crossing collapses to one announce ──── */

test('v0.75.0 — a long-offline reconnect at low SoC announces only the worst band', () => {
  const fired: SocThreshold[] = [];
  const a = makeAlarm((t) => fired.push(t));
  const t0 = 1_700_000_000_000;
  a.update(60, t0); // cold-start baseline (no fire), arms every band
  assert.equal(fired.length, 0, 'cold start does not fire');
  // 11 min later the SHP2 returns at 17% (a long-offline reconnect → stale baseline,
  // so the slew guard re-baselines rather than rejecting). Crosses 50/40/30/20 in one
  // tick; only the most-severe (20%, medium) should announce — not the whole ladder.
  a.update(17, t0 + 11 * MIN);
  assert.equal(fired.length, 1, 'exactly one announce for a same-tick multi-band crossing');
  assert.equal(fired[0].pct, 20);
  assert.equal(fired[0].priority, 'medium');
});

test('v0.75.0 — gradual one-band-per-tick discharge still fires each band once (unchanged)', () => {
  const fired: number[] = [];
  const a = makeAlarm((t) => fired.push(t.pct));
  let now = 1_710_000_000_000;
  a.update(60, now); // baseline
  a.update(45, (now += MIN)); // crosses 50 only
  a.update(35, (now += MIN)); // crosses 40 only
  a.update(25, (now += MIN)); // crosses 30 only
  assert.deepEqual(fired, [50, 40, 30], 'a normal gradual discharge is byte-identical to before');
});

test('v0.75.0 — a fast same-tick discharge below the slew cap collapses to the worst band', () => {
  const fired: SocThreshold[] = [];
  const a = makeAlarm((t) => fired.push(t));
  let now = 1_720_000_000_000;
  a.update(28, now); // baseline just under 30 (arms 20/15/10/8/4/2)
  // 28→9 in one tick: 19-pt drop is under the 25-pt slew cap AND the baseline is
  // <30 so the guard is inactive; crosses 20/15/10 → announce only 10% (now
  // 'critical' — audit #24 reconciled the ladder to the reserve-floor classifier).
  a.update(9, (now += MIN));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].pct, 10);
  assert.equal(fired[0].priority, 'critical');
});

test('v0.75.0 — bands re-arm after recovery so a later dip re-announces the worst band', () => {
  const fired: number[] = [];
  const a = makeAlarm((t) => fired.push(t.pct));
  let now = 1_730_000_000_000;
  a.update(60, now);
  a.update(17, (now += 11 * MIN)); // collapse → 20
  a.update(60, (now += MIN)); // recover well above all bands → re-arm (no fire on the way up)
  a.update(17, (now += 11 * MIN)); // dip again after >10min → fire 20 again
  assert.deepEqual(fired, [20, 20]);
});

test('v0.75.0 — onCross fires for EVERY crossed band, flagging only the most-severe as primary', () => {
  // Guards the regression the adversarial review caught: the consumer (index.ts) records the
  // grid-downgrade re-escalation map inside onCross, so it must hear EVERY crossed band — not
  // just the announced one — or a later grid drop can fail-silent on the higher emergency bands.
  const calls: { pct: number; primary: boolean }[] = [];
  const sp = join(tmpdir(), `soc-perband-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(sp);
  const a = createBatterySocAlarm({ onCross: (t, primary) => calls.push({ pct: t.pct, primary }), statePath: sp });
  a.update(60, 0); // cold-start baseline (no fire)
  a.update(17, 11 * MIN); // stale baseline → crosses 50/40/30/20 in one tick
  assert.deepEqual(calls.map((c) => c.pct), [50, 40, 30, 20], 'consumer is notified of every crossed band');
  assert.deepEqual(
    calls.map((c) => c.primary),
    [false, false, false, true],
    'only the most-severe band (20%) is the primary/announced one',
  );
});

test('v0.75.0 — REGRESSION: grid-drop re-escalates ALL crossed emergency bands after a partial recovery', () => {
  // The first adversarial review's exact fail-silent scenario, locked in end-to-end: a FAITHFUL copy
  // of the index.ts onCross + socDowngraded re-escalation consumer, driven by the REAL alarm module.
  // On-grid same-tick multi-emergency crossing → partial recovery above the worst band → grid drop
  // MUST audibly re-escalate the shallower high bands (pre-collapse behaviour). If the collapse had
  // starved socDowngraded of the non-worst bands (the bug), the grid drop would be silent here.
  const sp = join(tmpdir(), `soc-reesc-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(sp);
  const announced: { pct: number; priority: AlarmPriority }[] = [];
  const socDowngraded = new Map<number, AlarmPriority>();
  let backstopping = true; // grid present
  // v0.76.0 — drives the REAL extracted dispatch functions (socGridCrossDecision +
  // reEscalateGridDrop) instead of a hand-copied mirror, so this regression can no
  // longer pass while index.ts's actual logic drifts. The only thing reproduced
  // here is index.ts's tiny onCross consumer glue (record every band, announce
  // only the primary) — the grid-downgrade decision and the re-escalation pass are
  // the production functions verbatim.
  const a = createBatterySocAlarm({
    statePath: sp,
    onCross: (t, isPrimary) => {
      const { priority, onGrid } = socGridCrossDecision(t, backstopping);
      if (onGrid) socDowngraded.set(t.pct, t.priority);
      else socDowngraded.delete(t.pct);
      if (!isPrimary) return;
      announced.push({ pct: t.pct, priority });
    },
  });
  const reEscalate = (soc: number) => {
    for (const band of reEscalateGridDrop(socDowngraded, soc, backstopping, () => true)) {
      announced.push(band);
    }
  };

  a.update(12, 0); // boot low, on-grid (baseline <30 arms 10/8/4/2)
  a.update(3, 1 * MIN); reEscalate(3); // 12→3 crosses 10/8/4 in one tick — collapse announces worst(4) only
  // Despite the audible collapse, EVERY crossed emergency band is recorded for later re-escalation:
  assert.deepEqual([...socDowngraded.keys()].sort((x, y) => y - x), [10, 8, 4]);
  a.update(5, 2 * MIN); reEscalate(5); // partial recovery to 5%: climbs out 4 (5>4); 8/10 remain
  assert.deepEqual([...socDowngraded.keys()].sort((x, y) => y - x), [10, 8]);
  backstopping = false; // GRID DROPS
  a.update(5, 3 * MIN); reEscalate(5); // at 5% off-grid → re-escalate the still-active emergency bands
  // audit #24 — 10%/8% are now priority='critical' in the ladder (reconciled to the reserve-floor classifier).
  const reesc = announced.filter((x) => x.priority === 'critical').map((x) => x.pct).sort((x, y) => y - x);
  assert.deepEqual(reesc, [10, 8], 'grid drop must audibly re-escalate the higher emergency bands, not go silent');
});

test('cleanup — remove tmp state files (best effort)', () => {
  for (const p of tmpPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});
