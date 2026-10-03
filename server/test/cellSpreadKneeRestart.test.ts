/**
 * v1.187.0 log review — the end-of-charge knee ACROSS A RESTART.
 *
 * The knee state (advanceVdiffKnee's critSinceMs, and the session's graceFromMs) lives in memory.
 * An auto-update restart at minute 21 of a balancing-held top-of-charge spread — one that had
 * just been announced by the 20-minute bound — started a fresh clock, and the balancing mute held
 * it silent for up to 20 more minutes; a charge-only spread got a fresh 5-minute grace after every
 * restart. A pack with no state now starts from the persisted onset of its standing
 * `vdiff-crit-<sn>-<pk>` (vdiffKneeSeed, alertOnset.ts), so the bounds keep counting from the
 * first crossing (fail loud). The activity evidence is never restored.
 *
 * And the push side of the same restart: a critical held silent before the restart has no
 * notify-state record, and the boot seed marked it "already notified", so when the grace lapsed it
 * was spoken but never pushed (bootSeedNotified).
 *
 * The restart is simulated as the process loses it: the module's knee map is cleared and the onset
 * store is re-read from its file.
 */
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/* ── environment: set BEFORE any src module is loaded (the onset path is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-knee-restart-'));
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');

const {
  computeAlerts, resetVdiffWarnHoldForTesting, vdiffKneeSeed, advanceVdiffKnee, VDIFF_KNEE_MAX_MUTE_MS, VDIFF_KNEE_RELAX_MS,
  VDIFF_KNEE_GAP_CARRY_MS,
} = await import('../src/alerts.js');
const { syncAlertOnsets, resetAlertOnsetCacheForTests, getAlertOnset } = await import('../src/alertOnset.js');
const { bootSeedNotified, bootRetrackDecision, decideAlertDispatch } = await import('../src/alertMonitor.js');
type Alert = import('../src/alerts.js').Alert;
type DeviceSnapshot = import('../src/snapshot.js').DeviceSnapshot;

const SN = 'DPU-KNEE';
const CRIT_ID = `vdiff-crit-${SN}-1`;
const TICK_MS = 20_000;
const MIN = 60_000;
const T0 = Date.parse('2026-09-29T15:00:00-07:00');
let clock = 0;

interface Reading { vd: number; soc: number; bal: 0 | 1; in: number }
function device(r: Reading): Record<string, DeviceSnapshot> {
  const pack = {
    num: 1, soc: r.soc, packSn: 'PACK-A', inputWatts: r.in, outputWatts: 0,
    streamInputW: { w: r.in, atMs: clock },
    maxVolDiffMv: r.vd, maxCellVoltageMv: 3400 + r.vd, minCellVoltageMv: 3400,
    balanceState: r.bal, cellVoltagesMv: [],
  };
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 9', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: r.soc, packs: [pack],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}

/** One monitor tick: computeAlerts, then the monitor's onset stamping (syncAlertOnsets). */
function tick(atMs: number, r: Reading): Alert | undefined {
  clock = atMs;
  const alerts = computeAlerts(device(r));
  syncAlertOnsets(alerts.map((a) => a.id), atMs);
  return alerts.find((a) => a.id === CRIT_ID);
}
/** The process restarts: the in-memory knee state is gone, the onset store is re-read from disk. */
function restart(): void {
  resetVdiffWarnHoldForTesting();
  resetAlertOnsetCacheForTests();
}

beforeEach(() => {
  restart();
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('★★★ a restart at minute 21 does not restart the 20-minute bound: the balancing-held spread keeps annunciating', () => {
  // The 08-22/23 fault class: a sustained 110 mV top-of-charge spread the BMS keeps balancing.
  const r: Reading = { vd: 110, soc: 99, bal: 1, in: 0 };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, r)!.annunciate, false);
  assert.notEqual(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, r)!.annunciate, false, 'the bound speaks at minute 20');
  assert.equal(getAlertOnset(CRIT_ID), T0, 'the critical\'s onset is persisted');
  restart(); // an auto-update at minute 21
  const back = tick(T0 + 21 * MIN, r);
  assert.notEqual(back!.annunciate, false, 'still at the line, still balancing: announced at once');
  assert.match(back!.detail, /First reached the critical line 21 minutes ago\./);
  for (let t = 21 * MIN + TICK_MS; t < 45 * MIN; t += TICK_MS) {
    assert.notEqual(tick(T0 + t, r)!.annunciate, false, `+${t / 1000}s: silenced again after the restart`);
  }
});

test('★★★ …the defect it fixes: with no persisted onset the restart bought 20 more minutes of silence', () => {
  const r: Reading = { vd: 110, soc: 99, bal: 1, in: 0 };
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, r);
  restart();
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true }); // the onset is lost too
  resetAlertOnsetCacheForTests();
  const back = tick(T0 + 21 * MIN, r);
  assert.equal(back!.annunciate, false);
  assert.equal(back!.mutedBy, 'balancing');
});

test('★★★ a restart inside the charging grace does not re-grant it', () => {
  // 110 mV at 97% on a steady 600 W charge, the BMS idle: the charge grace is 5 minutes from the
  // first crossing (T0). A restart at minute 3 must not open another 5.
  const r: Reading = { vd: 110, soc: 97, bal: 0, in: 600 };
  for (let t = 0; t < 3 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, r)!.mutedBy, 'charging');
  restart();
  let first: number | null = null;
  for (let t = 3 * MIN; t <= 10 * MIN; t += TICK_MS) {
    const a = tick(T0 + t, r)!;
    if (a.annunciate !== false && first == null) first = t;
    if (first != null) assert.notEqual(a.annunciate, false, `+${t / 1000}s: silenced again`);
  }
  assert.equal(first, VDIFF_KNEE_RELAX_MS, 'announced 5 minutes from the FIRST crossing, not from the restart');
});

test('★★ a benign knee across a restart stays silent (the seed restores clocks, and the mutes are re-earned)', () => {
  // Balancing at the knee, a restart a minute in, balancing stops at minute 4, relaxed at minute 6.
  for (let t = 0; t < MIN; t += TICK_MS) assert.equal(tick(T0 + t, { vd: 95, soc: 100, bal: 1, in: 0 })!.annunciate, false);
  restart();
  for (let t = MIN; t < 4 * MIN; t += TICK_MS) {
    assert.equal(tick(T0 + t, { vd: 95, soc: 100, bal: 1, in: 0 })!.mutedBy, 'balancing');
  }
  for (let t = 4 * MIN; t < 6 * MIN; t += TICK_MS) {
    assert.equal(tick(T0 + t, { vd: 93, soc: 100, bal: 0, in: 0 })!.mutedBy, 'end-of-charge');
  }
  assert.equal(tick(T0 + 6 * MIN, { vd: 67, soc: 100, bal: 0, in: 0 }), undefined, 'relaxed under the line');
});

test('★★ (v1.187.1) a SEEDED critical-line clock ends at once on a first reading under 50 mV, and survives one in the 50-89 mV band', () => {
  // In the process an episode survives readings under 50 mV until an unbroken VDIFF_KNEE_RELAX_MS
  // (log review); a clock seeded from a persisted onset — perhaps a day old, never seen in this
  // process — still ends on a reading under 50 mV, as in v1.187.0. The add-on is down for 70
  // minutes here (no knee-session file in this suite), longer than VDIFF_KNEE_GAP_CARRY_MS, so the
  // seed carries the critical-line clock only, never the session.
  const hi: Reading = { vd: 110, soc: 90, bal: 1, in: 0 };
  const backMin = 20 + 70;
  for (const [label, firstBack, loud] of [['50-89 mV', 70, true], ['under 50 mV', 30, false]] as const) {
    restart();
    rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
    resetAlertOnsetCacheForTests();
    for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, hi)!.mutedBy, 'balancing', label);
    assert.notEqual(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, hi)!.annunciate, false, `${label}: the 20-minute bound speaks in-process`);
    restart();
    assert.equal(vdiffKneeSeed(getAlertOnset(CRIT_ID), 'PACK-A', T0 + backMin * MIN)!.graceFromMs, null, 'no session seeded');
    assert.equal(tick(T0 + backMin * MIN, { vd: firstBack, soc: 90, bal: 1, in: 0 }), undefined, `${label}: under the plateau line`);
    const back = tick(T0 + (backMin + 1) * MIN, hi)!;
    if (loud) {
      assert.notEqual(back.annunciate, false, `${label}: the seeded episode stands`);
      assert.match(back.detail, new RegExp(`First reached the critical line ${backMin + 1} minutes ago\\.`));
    } else {
      assert.equal(back.mutedBy, 'balancing', `${label}: the seeded episode ended — a new one, muted while balancing`);
    }
  }
});

test('★★★ (v1.187.2) a seeded clock not yet confirmed at the line ends on ANY reading under 50 mV — not only the first after the restart', () => {
  // The add-on returns the next day to a day-old onset (the critical stood when it went down). The
  // first reading is 70 mV on the plateau — under the plateau line, not under 50 mV — then the pack
  // reads 30 mV, then a benign balancing crossing two minutes later. v1.187.1 cleared the seed only
  // on the FIRST reading after the restart, so the day-old onset was carried through the 30 mV
  // readings for VDIFF_KNEE_RELAX_MS and the crossing annunciated at once ("First reached the
  // critical line 1443 minutes ago."). Now the seed ends on the first reading under 50 mV.
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  assert.equal(getAlertOnset(CRIT_ID), T0);
  restart();
  const back = T0 + 24 * 60 * MIN;
  assert.equal(tick(back, { vd: 70, soc: 90, bal: 1, in: 0 }), undefined, 'under the plateau line');
  for (let t = MIN; t < 3 * MIN; t += TICK_MS) assert.equal(tick(back + t, { vd: 30, soc: 90, bal: 1, in: 0 }), undefined);
  const knee = tick(back + 3 * MIN, { vd: 95, soc: 90, bal: 1, in: 0 })!;
  assert.equal(knee.mutedBy, 'balancing', 'a new episode, muted while balancing');
  assert.doesNotMatch(knee.detail, /First reached the critical line/);
});

test('★★ (v1.187.2) …while a seeded clock CONFIRMED by a reading at the line follows the in-process rule: a dip under 50 mV does not end it', () => {
  // The critical still standing when the add-on returns: the first reading is at the line, so the
  // episode is the one the onset names, and a single 45 mV reading after it is a dip, not a reset.
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  restart();
  const back = T0 + 3 * 60 * MIN;
  assert.notEqual(tick(back, { vd: 110, soc: 90, bal: 1, in: 0 })!.annunciate, false, 'loud from its old onset');
  for (let t = TICK_MS; t < 3 * MIN; t += TICK_MS) assert.equal(tick(back + t, { vd: 45, soc: 90, bal: 1, in: 0 }), undefined);
  const again = tick(back + 3 * MIN, { vd: 110, soc: 90, bal: 1, in: 0 })!;
  assert.notEqual(again.annunciate, false, 'the confirmed episode stands through the dip');
  assert.match(again.detail, /First reached the critical line 183 minutes ago\./);
});

test('★★★ (v1.187.2) a critical STILL standing after an outage longer than the carry starts its session from its onset: hi / lo / lo at 90% stays loud', () => {
  // (The review of this release.) The seed carries the critical-line clock only (the onset is three
  // hours old); the first reading back is at the line, which confirms it and starts the session from
  // it (graceFromMs ??= critSinceMs). The fault then dips under the line for 6 minutes between
  // crossings, which ends the episode each time: started from the confirming tick instead, the
  // session muted the next crossings for about 5 minutes.
  for (let t = 0; t <= 21 * MIN; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  assert.equal(getAlertOnset(CRIT_ID), T0);
  restart();
  const back = T0 + 3 * 60 * MIN;
  let crit = 0;
  for (let t = 0; t < 60 * MIN; t += TICK_MS) {
    const hi = Math.floor(t / (3 * MIN)) % 3 === 0;
    const a = tick(back + t, { vd: hi ? 110 : 45, soc: 90, bal: 1, in: 0 });
    if (!a) continue;
    crit++;
    assert.notEqual(a.annunciate, false, `+${t / 1000}s after the restart: muted (${a.mutedBy})`);
  }
  assert.ok(crit > 20);
});

test('★★ (v1.187.2) a session seeded from an onset inside the carry is a SESSION: a reading under 50 mV ends its critical-line clock, not the session', () => {
  // A restart one minute after the in-process bound spoke, the knee-session file absent (the
  // fallback): both clocks are seeded from the 21-minute-old onset. The first reading is 30 mV —
  // the seeded critical-line clock ends — but the session, like any session, ends only below the
  // plateau or after a 20-minute rest, and it bounds the balancing mute on the next crossing.
  const hi: Reading = { vd: 110, soc: 90, bal: 1, in: 0 };
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, hi);
  restart();
  assert.equal(tick(T0 + 21 * MIN, { vd: 30, soc: 90, bal: 1, in: 0 }), undefined);
  const back = tick(T0 + 22 * MIN, hi)!;
  assert.notEqual(back.annunciate, false, 'the seeded session is 22 minutes old');
  assert.match(back.detail, /First reached the critical line above 85% charge 22 minutes ago\./,
    'the session bound, not the (ended) episode clock');
});

test('★★ the seed carries no evidence: an idle pack at the line after a restart speaks at once', () => {
  tick(T0, { vd: 95, soc: 100, bal: 1, in: 0 });
  restart();
  const a = tick(T0 + TICK_MS, { vd: 95, soc: 100, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false, 'the balancing seen before the restart is not restored');
});

test('vdiffKneeSeed — both clocks from the onset, no evidence; nothing without an onset; never ahead of now', () => {
  assert.equal(vdiffKneeSeed(undefined, 'P', T0), undefined);
  assert.equal(vdiffKneeSeed(Number.NaN, 'P', T0), undefined);
  assert.deepEqual(vdiffKneeSeed(T0 - 5 * MIN, 'P', T0), {
    packSn: 'P', lastBalancingMs: null, lastChargeMs: null, critSinceMs: T0 - 5 * MIN,
    belowCritSinceMs: null, graceFromMs: T0 - 5 * MIN, quietSinceMs: null, lastSeenMs: null,
    critSeeded: true,
  });
  const ahead = vdiffKneeSeed(T0 + 5 * MIN, 'P', T0)!;
  assert.equal(ahead.critSinceMs, T0, 'an onset ahead of the clock (a clock step) is clamped to now');
  assert.equal(ahead.graceFromMs, T0);
  // The SESSION clock only from an onset no older than the in-process gap carry; the critical-line
  // clock from any onset (a critical still standing fails loud).
  assert.equal(vdiffKneeSeed(T0 - VDIFF_KNEE_GAP_CARRY_MS, 'P', T0)!.graceFromMs, T0 - VDIFF_KNEE_GAP_CARRY_MS);
  const stale = vdiffKneeSeed(T0 - VDIFF_KNEE_GAP_CARRY_MS - 1, 'P', T0)!;
  assert.equal(stale.graceFromMs, null, 'an onset from before a long outage is not the current session');
  assert.equal(stale.critSinceMs, T0 - VDIFF_KNEE_GAP_CARRY_MS - 1);
});

test('advanceVdiffKnee — critSeeded (v1.187.2): set by the seed only; cleared by a reading at the line, by the reset it allows, and off the plateau', () => {
  const obs = (spreadMv: number, packSoc: number | null = 90) => ({ packSn: 'P', packSoc, spreadMv, balancing: true, chargeW: null });
  const day = T0 - 24 * 60 * MIN;
  assert.equal(advanceVdiffKnee(undefined, obs(95), T0).critSeeded, false, 'a crossing seen in the process is not seeded');
  assert.equal(advanceVdiffKnee(undefined, obs(30), T0).critSeeded, false, 'nor a fresh state with no clock');
  // 50-89 mV on the plateau: under the line, not under 50 mV — the seed stands, still unconfirmed…
  let s = advanceVdiffKnee(vdiffKneeSeed(day, 'P', T0), obs(70), T0);
  assert.equal(s.critSinceMs, day);
  assert.equal(s.critSeeded, true);
  s = advanceVdiffKnee(s, obs(70), T0 + MIN);
  assert.equal(s.critSeeded, true, 'still unconfirmed on the second reading');
  // …and any later reading under 50 mV ends it, with its mark.
  const ended = advanceVdiffKnee(s, obs(49), T0 + 2 * MIN);
  assert.equal(ended.critSinceMs, null);
  assert.equal(ended.critSeeded, false);
  assert.equal(advanceVdiffKnee(s, obs(50), T0 + 2 * MIN).critSinceMs, day, 'the line is exclusive: 50 mV is not under it');
  // A reading at the line confirms it: the in-process rule from then on.
  const confirmed = advanceVdiffKnee(s, obs(90), T0 + 2 * MIN);
  assert.equal(confirmed.critSeeded, false);
  assert.equal(confirmed.critSinceMs, day);
  assert.equal(advanceVdiffKnee(confirmed, obs(45), T0 + 3 * MIN).critSinceMs, day, 'a dip under 50 mV no longer ends it');
  // VDIFF_KNEE_RELAX_MS under the line ends a seeded clock too, with its mark.
  const run = advanceVdiffKnee(s, obs(70), T0 + VDIFF_KNEE_RELAX_MS);
  assert.equal(run.critSinceMs, null);
  assert.equal(run.critSeeded, false);
  // Off the plateau the clock and its mark are cleared; an unknown SoC is off the plateau.
  for (const soc of [84, null]) {
    const off = advanceVdiffKnee(vdiffKneeSeed(day, 'P', T0), obs(60, soc), T0);
    assert.equal(off.critSinceMs, null, `SoC ${soc}`);
    assert.equal(off.critSeeded, false, `SoC ${soc}`);
  }
});

test('★★ a long outage that began inside a knee does not cost the next day\'s knee its grace', () => {
  // The add-on stops 1000 s into a benign knee, its critical standing and muted (the onset is
  // persisted). The pack discharges and recharges unseen; the add-on returns the next afternoon
  // with the pack at 99% and a 10 mV spread, a few minutes before the day's knee. Seeded from
  // yesterday's onset, the session was never ended (no reading below 95%) and the knee had no grace.
  for (let t = 0; t < 1000_000; t += TICK_MS) assert.equal(tick(T0 + t, { vd: 95, soc: 100, bal: 1, in: 0 })!.annunciate, false);
  assert.equal(getAlertOnset(CRIT_ID), T0, 'the standing critical\'s onset is persisted');
  restart();
  const back = T0 + 24 * 60 * MIN - 10 * MIN; // 14:50 the next day
  for (let t = 0; t < 5 * MIN; t += TICK_MS) assert.equal(tick(back + t, { vd: 10, soc: 99, bal: 0, in: 0 }), undefined);
  // The knee: balancing at the line, balancing stops, relaxed under the line 2 minutes later.
  for (let t = 5 * MIN; t < 9 * MIN; t += TICK_MS) {
    const a = tick(back + t, { vd: 95, soc: 100, bal: 1, in: 0 })!;
    assert.equal(a.mutedBy, 'balancing', `+${t / 1000}s: balancing`);
  }
  for (let t = 9 * MIN; t < 11 * MIN; t += TICK_MS) {
    const a = tick(back + t, { vd: 93, soc: 100, bal: 0, in: 0 })!;
    assert.equal(a.mutedBy, 'end-of-charge', `+${t / 1000}s: the end-of-charge grace, earned again`);
  }
  assert.equal(tick(back + 11 * MIN, { vd: 67, soc: 100, bal: 0, in: 0 }), undefined);
});

test('★★ …while a critical STILL standing when the add-on returns fails loud from its old onset', () => {
  for (let t = 0; t < 1000_000; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 100, bal: 1, in: 0 });
  restart();
  const a = tick(T0 + 3 * 60 * MIN, { vd: 110, soc: 100, bal: 1, in: 0 })!;
  assert.notEqual(a.annunciate, false, 'at the line on the first reading back: the episode is 3 hours old');
});

/* ── the push side: a critical is never boot-seeded without a delivery record ─────────────── */

test('★★★ bootSeedNotified: a CRITICAL present at boot with no notify-state record is not seeded — it pushes once', () => {
  const crit = { id: CRIT_ID, severity: 'critical' as const };
  assert.equal(bootSeedNotified({ alert: crit, firstRun: true, alreadyNotified: false }), false);
  assert.equal(bootSeedNotified({ alert: crit, firstRun: true, alreadyNotified: true }), true, 'a pushed critical stays deduped');
  assert.equal(bootSeedNotified({ alert: crit, firstRun: false, alreadyNotified: false }), false);
  // A standing warning is still boot-seeded (no re-push storm on every restart).
  assert.equal(bootSeedNotified({ alert: { id: 'soc-low-DPU-A-1', severity: 'warning' }, firstRun: true, alreadyNotified: false }), true);
  assert.equal(bootSeedNotified({ alert: { id: 'soc-low-DPU-A-1', severity: 'info' }, firstRun: true, alreadyNotified: false }), true);
});

test('★★★ the restart chain: a vdiff-crit held by a grace across the restart is pushed when the grace lapses', () => {
  const bootMs = T0 + 3 * MIN;
  // Re-tracked on its first appearance since boot: the onset predates the boot.
  const boot = bootRetrackDecision({ firstRun: false, firstAppearance: true, priorOnsetMs: T0, bootMs });
  assert.deepEqual(boot, { retrack: true, seedAsBoot: true });
  // Held silent before the restart: never pushed, so no record.
  const notified = bootSeedNotified({ alert: { id: CRIT_ID, severity: 'critical' }, firstRun: boot.seedAsBoot, alreadyNotified: false });
  assert.equal(notified, false);
  // The grace lapses and the critical annunciates: the rising-edge decision dispatches the push.
  assert.equal(decideAlertDispatch({
    qualifies: true, alreadyNotified: notified, alreadyQueued: false, escalated: false,
    debounceElapsed: true, inQuiet: false, breaksThrough: false,
  }), 'dispatch');
});

test('★★ a restart between two crossings of the charge-following fault does not re-grant the session grace', () => {
  // 95 / 45 mV on alternate ~180 s readings at 97% on a 600 W charge; the add-on restarts just as
  // the reading drops to 45 mV. The critical is absent on that reading, but its onset is still
  // on record, and the pack's session clock starts from it.
  const hi: Reading = { vd: 95, soc: 97, bal: 0, in: 600 };
  const lo: Reading = { vd: 45, soc: 97, bal: 0, in: 600 };
  for (let t = 0; t < 180_000; t += TICK_MS) assert.equal(tick(T0 + t, hi)!.mutedBy, 'charging');
  restart();
  for (let t = 180_000; t < 360_000; t += TICK_MS) assert.equal(tick(T0 + t, lo), undefined);
  const next = tick(T0 + 360_000, hi);
  assert.notEqual(next!.annunciate, false, 'the next crossing, 6 minutes into the session, is announced');
});
