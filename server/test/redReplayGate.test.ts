import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alertFingerprint,
  clearsRedReplayEvidence,
  createRedReplayGate,
  describeFingerprint,
  isFingerprint,
  isLevelEscalation,
  isRedReplaySuppressed,
  isRecordableRedAnnounce,
  parseRedAnnounceState,
  voicedRedFingerprint,
  LEVEL_RANK,
  RED_REPLAY_MIN_GAP_MS,
  type BroadcastLevel,
  type RedAnnounceState,
} from '../src/redReplayGate.js';
import { conditionFromAlerts, isRestartContinuation } from '../src/broadcast.js';
import { buildAlertMessage, pickPrimaryAlert } from '../src/ttsService.js';
import { computeAlerts, type Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.64.0 — post-restart RED replay gate.
 *
 * THE MEASURED PROBLEM: critical_alerts has been >= 1 for 98.8 % of live coverage
 * (Core 3 Pack 1 carries a standing "Battery protection fault"). RED is never
 * restart-suppressed, so every add-on restart re-announced it aloud — five deploys
 * produced five klaxons in four hours on 2026-08-03, and 10 of 11 restarts did the
 * same on 2026-08-02.
 *
 * THE GATE: suppress a restart RED re-announce ONLY when all of these hold —
 *   (1) inside the boot warm-up window,
 *   (2) this red is not an ESCALATION over the last level actually played,
 *   (3) the critical that would be SPOKEN now has the same FINGERPRINT as the one
 *       that WAS spoken at the last successful red announcement,
 *   (4) no unrecognised critical is active alongside it, and
 *   (5) that announcement was < 30 min ago.
 *
 * ★★★ Identity is the safety property, not a nicety — and identity is a
 * FINGERPRINT (id + title + fault code), never the bare id. `dpu-err-<sn>` is
 * emitted for EVERY value of sysErrCode, so a bare-id gate would mute a genuinely
 * different fault on the same device. `sameSourceDifferentCode` below is that
 * scenario; it must always announce.
 */

const WIN = 10 * 60 * 1000;
const GAP = 30 * 60 * 1000;
const T0 = 1_800_000_000_000; // fixed epoch — no wall-clock dependence anywhere

/* ─── the fixtures, shaped exactly as alerts.ts emits them ──────────────── */

/** The standing Core 3 fault: id constant across codes, 5xx ⇒ battery band. */
const STANDING = { id: 'dpu-err-GBC0314', title: 'Battery protection fault', fault: 'err533' };
/** THE SAME SOURCE, a genuinely different fault: same id, other band, other code. */
const OTHER_CODE = { id: 'dpu-err-GBC0314', title: 'Inverter error code', fault: 'err307' };
/** A different device entirely. */
const THERMAL = { id: 'thermal-runaway-core1', title: 'Pack over-temperature', fault: undefined };

const FP_STANDING = alertFingerprint(STANDING);
const FP_OTHER_CODE = alertFingerprint(OTHER_CODE);
const FP_THERMAL = alertFingerprint(THERMAL);

/** Persisted evidence of a successful red announcement. */
const announced = (p: {
  atMs?: number;
  voiced?: string;
  active?: string[];
  lastPlayedLevel?: BroadcastLevel;
} = {}): RedAnnounceState => ({
  lastRedAnnouncedAtMs: p.atMs ?? T0,
  voicedFingerprint: p.voiced ?? FP_STANDING,
  activeFingerprints: [...(p.active ?? [p.voiced ?? FP_STANDING])],
  lastPlayedLevel: p.lastPlayedLevel ?? 'red',
});

const suppressed = (p: {
  /** what would be SPOKEN now; defaults to the first active fingerprint */
  voiced?: string | null;
  active: string[];
  persisted: RedAnnounceState | null;
  msSinceBoot?: number;
  sinceAnnounceMs?: number;
  observed?: BroadcastLevel;
}) =>
  isRedReplaySuppressed({
    observed: p.observed ?? 'red',
    voicedFingerprint: p.voiced !== undefined ? p.voiced : (p.active[0] ?? null),
    activeFingerprints: p.active,
    persisted: p.persisted,
    msSinceBoot: p.msSinceBoot ?? 90_000,
    nowMs: T0 + (p.sinceAnnounceMs ?? 5 * 60 * 1000),
    windowMs: WIN,
    minGapMs: GAP,
  });

/* ═══════════════════════════════════════════════════════════════════════════
 * ★★★ BLOCKER 1 — identity is the SOURCE, not the FAULT.
 * The reviewer's probe, verbatim: same source id, a DIFFERENT error code, inside
 * the boot window, 9 minutes after the last red. A bare-id gate suppressed it.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('★ BLOCKER 1 (A) — same source id, DIFFERENT error code/title, 9 min after the last red → ANNOUNCES', () => {
  // The premise the whole finding rests on: these are the SAME alert id.
  assert.equal(STANDING.id, OTHER_CODE.id, 'dpu-err ids are deliberately constant across every error code');
  // The standing 533 cleared; a real 307 appeared on the same device. Debounce is
  // 3 min and re-baselines on a code change, so drop → 3 min → re-raise fits well
  // inside the 10-min boot window.
  assert.equal(
    suppressed({
      active: [FP_OTHER_CODE],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING] }),
      msSinceBoot: 5 * 60 * 1000,
      sinceAnnounceMs: 9 * 60 * 1000,
    }),
    false,
    'a different fault on the same device must never be muted by the fault it replaced',
  );
});

test('★ BLOCKER 1 (A) — the id ALONE cannot tell these apart; the fingerprint can', () => {
  assert.equal(STANDING.id, OTHER_CODE.id);
  assert.notEqual(FP_STANDING, FP_OTHER_CODE, 'title + error code must separate them');
  // And a title change alone (same code) is enough, as is a code change alone.
  assert.notEqual(
    alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err533' }),
    alertFingerprint({ id: 'dpu-err-X', title: 'Inverter error code', fault: 'err533' }),
  );
  assert.notEqual(
    alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err533' }),
    alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err534' }),
  );
});

test('★ BLOCKER 1 (A2) — same id, SAME code and title, genuinely unchanged → still SUPPRESSED', () => {
  // The counter-test. If the fingerprint folded in anything that drifts, this
  // would fail and the whole gate would be a no-op that never suppresses.
  assert.equal(
    suppressed({
      active: [FP_STANDING],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING] }),
      msSinceBoot: 5 * 60 * 1000,
      sinceAnnounceMs: 9 * 60 * 1000,
    }),
    true,
    'the identical standing fault, spoken 9 min ago, must not klaxon again',
  );
});

test('★ BLOCKER 1 (A2) — the fingerprint IGNORES drifting fields: detail, facts, device, severity', () => {
  // vdiff-crit prints a live `cell spread <n> mV`; soh-crit prints a percentage.
  // Folding detail/facts in would make every tick a new fault ⇒ permanent no-op.
  const a = { id: 'vdiff-crit-SN-1', title: 'Cell imbalance', detail: 'Core 3 pack 1 cell spread 92 mV (critical >= 90 mV).', facts: [{ label: 'Spread', value: '92 mV' }] };
  const b = { id: 'vdiff-crit-SN-1', title: 'Cell imbalance', detail: 'Core 3 pack 1 cell spread 118 mV (critical >= 90 mV).', facts: [{ label: 'Spread', value: '118 mV' }] };
  assert.equal(alertFingerprint(a), alertFingerprint(b), '★ a live measurement is not a different fault');
});

test('★ BLOCKER 1 — END TO END through computeAlerts: dpu-err code change ⇒ same id, DIFFERENT fingerprint', () => {
  const dpu = (sysErrCode: number, soc: number, batVol: number): Record<string, DeviceSnapshot> => ({
    'DPU-1': {
      sn: 'GBC0314', deviceName: 'Core 3', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: T0,
      projection: {
        kind: 'dpu', soc, packs: [],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
        pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
        chgMaxSoc: 100, dsgMinSoc: 10,
      } as any,
    } as DeviceSnapshot,
  });
  const errOf = (code: number, soc: number, batVol: number): Alert =>
    computeAlerts(dpu(code, soc, batVol)).find((a) => a.id === 'dpu-err-GBC0314')!;

  const a533 = errOf(533, 95, 53);
  const a307 = errOf(307, 95, 53);
  // ★ 561 is in the SAME 5xx band as 533, so it carries the SAME title. Only the
  // threaded-out `fault` code separates them — this is the case a fingerprint of
  // id+title alone would still get wrong.
  const a561 = errOf(561, 95, 53);
  // Same code, WILDLY different live telemetry around it.
  const a533again = errOf(533, 41, 47);

  assert.equal(a533.id, a307.id, 'the id is constant across codes — the finding');
  assert.equal(a533.id, a561.id);
  assert.equal(a533.title, a561.title, 'same band ⇒ the TITLE is blind here too');
  assert.notEqual(alertFingerprint(a533), alertFingerprint(a307), '★ a real code change must be a new fault');
  assert.notEqual(alertFingerprint(a533), alertFingerprint(a561), '★ even within one band/title');
  assert.equal(
    alertFingerprint(a533), alertFingerprint(a533again),
    '★ and an unchanged fault must be byte-identical despite drifting telemetry',
  );
});

test('★ BLOCKER 1 — END TO END: shp2-src-err carries the code even though its TITLE never varies', () => {
  const shp2 = (errorCodeNum: number, backupBatPercent: number): DeviceSnapshot => ({
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: T0,
    projection: {
      kind: 'shp2', backupBatPercent, backupReserveSoc: 10, pairedCircuits: [],
      sources: [{ slot: 1, errorCodeNum, isConnected: true, hwConnect: true }],
    } as any,
  } as DeviceSnapshot);
  const srcErr = (n: number, pct: number): Alert =>
    computeAlerts([shp2(n, pct)] as any).find((a) => a.id === 'shp2-src-err-1')!;

  const a533 = srcErr(533, 80);
  const a461 = srcErr(461, 80);
  assert.equal(a533.title, a461.title, 'this title is a constant — the id+title pair alone is blind here');
  assert.equal(a533.id, a461.id);
  assert.notEqual(alertFingerprint(a533), alertFingerprint(a461), '★ the fault code is the only discriminator');
  assert.equal(alertFingerprint(a533), alertFingerprint(srcErr(533, 22)), 'stable under drifting SoC');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ★★★ BLOCKER 2 — the recorded set contained criticals that were NEVER SPOKEN.
 * buildAlertMessage voices exactly ONE alert (pickPrimaryAlert's choice).
 * ═══════════════════════════════════════════════════════════════════════════ */

const VOICED_A: Alert = {
  id: 'dpu-err-GBC0314', severity: 'critical', category: 'Battery', device: 'Core 3',
  title: 'Battery protection fault', fault: 'err533', coreNum: 3, packNum: 1,
  detail: 'Core 3 reports system error code 533 (battery/BMS protection band).',
};
const NEVER_VOICED_B: Alert = {
  id: 'shp2-src-err-2', severity: 'critical', category: 'SHP2', device: 'Smart Home Panel 2',
  title: 'Energy source error', fault: 'err401',
  detail: 'SHP2 slot 2 reports error code 401.',
};

test('★ BLOCKER 2 (B) — with two criticals active the REAL synthesiser names exactly one', () => {
  const primary = pickPrimaryAlert([VOICED_A, NEVER_VOICED_B], 'red');
  assert.equal(primary?.id, VOICED_A.id, 'located + Battery outranks unlocated SHP2');
  const spoken = buildAlertMessage('red', [VOICED_A, NEVER_VOICED_B]);
  assert.ok(spoken.includes(VOICED_A.title), 'the primary is named');
  assert.ok(!spoken.includes(NEVER_VOICED_B.title), '★ the second critical is NEVER said out loud');
});

test('★ BLOCKER 2 (B) — voicedRedFingerprint agrees with the synthesiser, whatever the array order', () => {
  // ★ The anti-drift pin. If this ever stops matching pickPrimaryAlert, the gate
  // would be comparing a fault the broadcast does not actually say.
  for (const arr of [[VOICED_A, NEVER_VOICED_B], [NEVER_VOICED_B, VOICED_A]]) {
    assert.equal(voicedRedFingerprint('red', arr), alertFingerprint(pickPrimaryAlert(arr, 'red')!));
    assert.equal(voicedRedFingerprint('red', arr), alertFingerprint(VOICED_A), 'never the merely-first element');
  }
  assert.equal(voicedRedFingerprint('yellow', [VOICED_A]), null, 'only red is this gate’s business');
  assert.equal(voicedRedFingerprint('green', [VOICED_A]), null);
  assert.equal(voicedRedFingerprint('red', []), null, 'nothing to say ⇒ nothing to match');
  assert.equal(
    voicedRedFingerprint('red', [{ ...VOICED_A, annunciate: false }]), null,
    'a non-annunciating critical is never spoken, so it can never be the voiced identity',
  );
});

test('★ BLOCKER 2 (B) — restart with ONLY the never-voiced critical active → ANNOUNCES', () => {
  const fpA = alertFingerprint(VOICED_A);
  const fpB = alertFingerprint(NEVER_VOICED_B);
  // What the pre-restart announcement recorded: A was spoken, both were active.
  const persisted = announced({ voiced: fpA, active: [fpA, fpB] });
  // The old subset rule would have suppressed this — B is IN the recorded set —
  // even though B was never once said aloud. Pin that so the regression is loud.
  assert.ok(persisted.activeFingerprints.includes(fpB), 'the old rule would have called B "already announced"');
  assert.equal(
    suppressed({ voiced: fpB, active: [fpB], persisted, msSinceBoot: 90_000, sinceAnnounceMs: 5 * 60 * 1000 }),
    false,
    '★ a critical nobody ever heard must not be muted by a broadcast that never named it',
  );
});

test('★ BLOCKER 2 (B) — the gate records only what was VOICED, and compares only that', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-voiced-'));
  try {
    const path = join(dir, 's.json');
    const fpA = alertFingerprint(VOICED_A);
    const fpB = alertFingerprint(NEVER_VOICED_B);
    const g1 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    g1.noteRedAnnounced({ voicedFingerprint: fpA, activeFingerprints: [fpA, fpB], nowMs: T0 });
    assert.equal(g1.state()?.voicedFingerprint, fpA, 'the SPOKEN one is the recorded identity');

    const g2 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP }); // the restart
    assert.equal(
      g2.shouldSuppress({ observed: 'red', voicedFingerprint: fpB, activeFingerprints: [fpB], msSinceBoot: 90_000, nowMs: T0 + 60_000 }),
      false,
      'only B survives the restart → it would now be spoken for the first time → announce',
    );
    assert.equal(
      g2.shouldSuppress({ observed: 'red', voicedFingerprint: fpA, activeFingerprints: [fpA, fpB], msSinceBoot: 90_000, nowMs: T0 + 60_000 }),
      true,
      'the unchanged pair, with A still the one spoken, is the same announcement',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BLOCKER 2 — nothing would be voiced (no annunciable critical) → ANNOUNCES', () => {
  assert.equal(
    suppressed({ voiced: null, active: [FP_STANDING], persisted: announced() }),
    false,
    'if we cannot name what we would say, we cannot claim it was already said',
  );
});

test('★ BLOCKER 2 — a NEW critical alongside the same voiced one still ANNOUNCES', () => {
  // The voiced fingerprint matching is necessary, never sufficient: an
  // unrecognised critical appearing is evidence that something CHANGED.
  assert.equal(
    suppressed({
      voiced: FP_STANDING,
      active: [FP_STANDING, FP_THERMAL],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING] }),
      msSinceBoot: 60_000,
      sinceAnnounceMs: 60_000,
    }),
    false,
    '★ a NEW critical must NEVER be swallowed by a same-rank red<=red match',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ★★★ BLOCKER 3 — return-to-green reset, and the escalation carve-out.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('★ BLOCKER 3 (C) — red → GREEN (all-clear) → red within 30 min → ANNOUNCES', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-green-'));
  try {
    const path = join(dir, 's.json');
    const gate = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    gate.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    // Sanity: without the green, this is the suppressed case.
    assert.equal(
      gate.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 60_000, nowMs: T0 + 5 * 60 * 1000 }),
      true,
    );
    // The condition returns to green — an all-clear. The next red is a NEW event.
    gate.noteConditionGreen();
    assert.equal(gate.state(), null, 'the evidence is destroyed, not merely aged');
    assert.equal(
      gate.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 60_000, nowMs: T0 + 6 * 60 * 1000 }),
      false,
      '★ a critical that cleared and re-raised is a new emergency, not a replay',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BLOCKER 3 (C) — the green reset survives to DISK: a restart after the all-clear announces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-green-disk-'));
  try {
    const path = join(dir, 's.json');
    const g1 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    g1.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    g1.noteConditionGreen();
    assert.equal(parseRedAnnounceState(JSON.parse(readFileSync(path, 'utf8'))), null, 'the on-disk record must no longer parse');

    const g2 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP }); // restart
    assert.equal(g2.state(), null);
    assert.equal(
      g2.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 60_000, nowMs: T0 + 8 * 60 * 1000 }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BLOCKER 3 (D) — an ESCALATION across the restart → ANNOUNCES', () => {
  // red announced → dropped to yellow (played) → restart → red again, same fault,
  // 9 min later. The last thing the operator actually heard was a yellow, so this
  // red is a RISE, and a rise is never a replay.
  assert.equal(
    suppressed({
      active: [FP_STANDING],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING], lastPlayedLevel: 'yellow' }),
      msSinceBoot: 90_000,
      sinceAnnounceMs: 9 * 60 * 1000,
    }),
    false,
    '★ escalations always play — same rule as the storm gate',
  );
  assert.equal(
    suppressed({
      active: [FP_STANDING],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING], lastPlayedLevel: 'green' }),
    }),
    false,
  );
  assert.equal(
    suppressed({
      active: [FP_STANDING],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING], lastPlayedLevel: 'red' }),
    }),
    true,
    'red → red is not an escalation; that is the only case suppression can apply to',
  );
});

test('★ BLOCKER 3 (D) — the demotion persists: yellow played after the red, then a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-escalate-'));
  try {
    const path = join(dir, 's.json');
    const g1 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    g1.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    g1.notePlayedBelowRed('yellow');
    assert.equal(g1.state()?.lastPlayedLevel, 'yellow');
    assert.equal(g1.state()?.voicedFingerprint, FP_STANDING, 'the red evidence itself is untouched');

    const g2 = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP }); // restart
    assert.equal(g2.state()?.lastPlayedLevel, 'yellow', 'the demotion reached disk');
    assert.equal(
      g2.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 90_000, nowMs: T0 + 9 * 60 * 1000 }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BLOCKER 3 (C) — GREEN, and only green, destroys the evidence', () => {
  assert.equal(clearsRedReplayEvidence('green'), true);
  assert.equal(clearsRedReplayEvidence('yellow'), false, 'a yellow demotes the played level; it is not an all-clear');
  assert.equal(clearsRedReplayEvidence('red'), false);
});

test('★ BLOCKER 3 — ONE rank ladder, shared with the storm gate', () => {
  assert.deepEqual(LEVEL_RANK, { green: 0, yellow: 1, red: 2 });
  assert.equal(isLevelEscalation('yellow', 'red'), true);
  assert.equal(isLevelEscalation('green', 'red'), true);
  assert.equal(isLevelEscalation('red', 'red'), false);
  assert.equal(isLevelEscalation('red', 'yellow'), false);
  assert.equal(isLevelEscalation(null, 'red'), true, 'unknown history is an escalation — fail open');
});

test('★ BLOCKER 3 — notePlayedBelowRed ignores red, and never invents state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-demote-'));
  try {
    const path = join(dir, 's.json');
    const g = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    g.notePlayedBelowRed('yellow');
    assert.equal(g.state(), null, 'a yellow with no prior red records nothing (null already announces)');
    g.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    g.notePlayedBelowRed('red');
    assert.equal(g.state()?.lastPlayedLevel, 'red', 'red is noteRedAnnounced’s business, not this one’s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ─── (a) same standing critical, restart, 5 min → SUPPRESSED ───────────── */

test('redReplayGate (a) — same standing critical + restart + 5 min since last announce → SUPPRESSED', () => {
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), sinceAnnounceMs: 5 * 60 * 1000 }),
    true,
    'the identical standing fault, announced 5 min ago, must not klaxon again',
  );
});

test('redReplayGate (a) — a SUBSET of the announced set, same voiced fault → SUPPRESSED', () => {
  // One of two announced criticals has since cleared, and the one still speaking
  // is the one that spoke before. Nothing NEW appeared, so there is nothing the
  // operator has not already heard.
  assert.equal(
    suppressed({
      voiced: FP_STANDING,
      active: [FP_STANDING],
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING, FP_THERMAL] }),
      sinceAnnounceMs: 5 * 60 * 1000,
    }),
    true,
  );
});

/* ─── (b) same standing critical, restart, 31 min → ANNOUNCES ───────────── */

test('redReplayGate (b) — same standing critical + 31 min since last announce → ANNOUNCES', () => {
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), sinceAnnounceMs: 31 * 60 * 1000 }),
    false,
    'past the 30-min gap a standing red replays — a reboot must still re-announce it',
  );
});

test('redReplayGate (b) — the boundary is EXCLUSIVE: exactly 30 min ANNOUNCES', () => {
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), sinceAnnounceMs: GAP }),
    false,
    '>= the gap announces (strictly-less-than suppresses)',
  );
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), sinceAnnounceMs: GAP - 1 }),
    true,
    'one millisecond under the gap still suppresses',
  );
});

/* ─── (c) ★★★ THE SAFETY TESTS — anything new or different announces ────── */

test('redReplayGate (c) ★ SAFETY: a NEW critical during warm-up while the old one is still active → ANNOUNCES at 1 minute', () => {
  assert.equal(
    suppressed({
      voiced: FP_STANDING,
      active: [FP_STANDING, FP_THERMAL],
      persisted: announced(),
      msSinceBoot: 60_000,
      sinceAnnounceMs: 60_000,
    }),
    false,
    'A NEW critical must NEVER be swallowed by a same-rank red<=red match',
  );
});

test('redReplayGate (c) ★ SAFETY: a wholly different critical (old one cleared) → ANNOUNCES', () => {
  assert.equal(
    suppressed({ active: [FP_THERMAL], persisted: announced(), sinceAnnounceMs: 30_000 }),
    false,
  );
});

test('redReplayGate (c) ★ SAFETY: one new fingerprint among many known ones → ANNOUNCES', () => {
  const a = alertFingerprint({ id: 'a', title: 'A' });
  const b = alertFingerprint({ id: 'b', title: 'B' });
  const cNew = alertFingerprint({ id: 'c', title: 'C' });
  assert.equal(
    suppressed({
      voiced: a,
      active: [a, b, cNew],
      persisted: announced({ voiced: a, active: [a, b] }),
      sinceAnnounceMs: 10_000,
    }),
    false,
    'a single unrecognised fingerprint is enough to defeat suppression',
  );
});

test('redReplayGate (c) ★ SAFETY: a red with NO identifiable criticals is incoherent → ANNOUNCES', () => {
  // red implies crit > 0, so an empty set means we cannot prove sameness.
  assert.equal(suppressed({ voiced: FP_STANDING, active: [], persisted: announced(), sinceAnnounceMs: 60_000 }), false);
});

/* ─── (d) missing / corrupt persisted state → ANNOUNCES (fail-safe) ─────── */

test('redReplayGate (d) — NO persisted state → ANNOUNCES (fail open)', () => {
  assert.equal(suppressed({ active: [FP_STANDING], persisted: null }), false);
});

test('redReplayGate (d) — corrupt/type-invalid persisted state parses to null → ANNOUNCES', () => {
  const good = { lastRedAnnouncedAtMs: T0, voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], lastPlayedLevel: 'red' };
  for (const bad of [
    null,
    undefined,
    'nonsense',
    42,
    {},
    { ...good, lastRedAnnouncedAtMs: undefined },
    { ...good, lastRedAnnouncedAtMs: '2026-08-03' },
    { ...good, lastRedAnnouncedAtMs: Number.NaN },
    { ...good, lastRedAnnouncedAtMs: Infinity },
    { ...good, lastRedAnnouncedAtMs: 0 },
    { ...good, lastRedAnnouncedAtMs: -1 },
    { ...good, voicedFingerprint: undefined },   // ★ no record of WHAT was said
    { ...good, voicedFingerprint: '' },          // ★ empty is not evidence
    { ...good, voicedFingerprint: 7 },
    { ...good, activeFingerprints: undefined },
    { ...good, activeFingerprints: 'a' },        // not an array
    { ...good, activeFingerprints: [1, 2] },     // not strings
    { ...good, lastPlayedLevel: undefined },     // ★ no record of the last level played
    { ...good, lastPlayedLevel: 'RED' },
    { ...good, lastPlayedLevel: 'amber' },
  ]) {
    assert.equal(parseRedAnnounceState(bad), null, `must reject ${JSON.stringify(bad)}`);
    assert.equal(
      suppressed({ active: [FP_STANDING], persisted: parseRedAnnounceState(bad) }),
      false,
      'unparseable evidence must never suppress an alarm',
    );
  }
  // ...and the well-formed control still parses, so the loop above is not vacuous.
  assert.deepEqual(parseRedAnnounceState(good), {
    lastRedAnnouncedAtMs: T0, voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], lastPlayedLevel: 'red',
  });
});

test('redReplayGate (d) — a corrupt state FILE on disk → ANNOUNCES (never throws)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-corrupt-'));
  try {
    const path = join(dir, 'broadcast-red-replay.json');
    writeFileSync(path, '{ this is not json');
    const gate = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    assert.equal(gate.state(), null);
    assert.equal(
      gate.shouldSuppress({
        observed: 'red',
        voicedFingerprint: FP_STANDING,
        activeFingerprints: [FP_STANDING],
        msSinceBoot: 60_000,
        nowMs: T0 + 60_000,
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redReplayGate (d) — a MISSING state file → ANNOUNCES', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-missing-'));
  try {
    const gate = createRedReplayGate({ statePath: join(dir, 'nope.json'), windowMs: WIN, minGapMs: GAP });
    assert.equal(gate.state(), null);
    assert.equal(
      gate.shouldSuppress({
        observed: 'red',
        voicedFingerprint: FP_STANDING,
        activeFingerprints: [FP_STANDING],
        msSinceBoot: 60_000,
        nowMs: T0 + 60_000,
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redReplayGate (d) — a FUTURE-dated timestamp (clock stepped back pre-NTP) → ANNOUNCES', () => {
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced({ atMs: T0 + 60 * 60 * 1000 }), sinceAnnounceMs: 0 }),
    false,
    'an unmeasurable gap must resolve toward noise, not silence',
  );
});

/* ─── (e) outside the warm-up window → gate irrelevant ──────────────────── */

test('redReplayGate (e) — outside the warm-up window the gate is INERT (normal behaviour)', () => {
  // Everything else is satisfied — same fault, 5 min ago — but this red arrived
  // hours into a run, so it is a live event, not a restart replay.
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), msSinceBoot: WIN + 1, sinceAnnounceMs: 5 * 60 * 1000 }),
    false,
  );
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), msSinceBoot: WIN, sinceAnnounceMs: 5 * 60 * 1000 }),
    false,
    'the window boundary is exclusive, matching msSinceBoot >= windowMs elsewhere',
  );
  assert.equal(
    suppressed({ active: [FP_STANDING], persisted: announced(), msSinceBoot: WIN - 1, sinceAnnounceMs: 5 * 60 * 1000 }),
    true,
    'just inside the window still suppresses',
  );
});

/* ─── (f) yellow/green continuation is UNCHANGED (regression guard) ─────── */

test('redReplayGate (f) — the red gate NEVER touches yellow or green', () => {
  for (const observed of ['yellow', 'green'] as const) {
    assert.equal(
      suppressed({ active: [FP_STANDING], persisted: announced(), observed }),
      false,
      `${observed} is isRestartContinuation's business, not this gate's`,
    );
  }
});

test('redReplayGate (f) — isRestartContinuation is unchanged: yellow/green suppress, RED still never does THERE', () => {
  // Verbatim regression guard over the v0.58.0 table. If a future edit "unifies"
  // the red rate limit back into this level-only function, these break.
  assert.equal(isRestartContinuation('yellow', 'yellow', 90_000, WIN), true);
  assert.equal(isRestartContinuation('red', 'green', 90_000, WIN), true);
  assert.equal(isRestartContinuation('red', 'yellow', 90_000, WIN), true);
  assert.equal(isRestartContinuation('yellow', 'red', 90_000, WIN), false);
  assert.equal(isRestartContinuation('green', 'yellow', 90_000, WIN), false);
  assert.equal(isRestartContinuation('red', 'red', 90_000, WIN), false, '★ level-only red suppression stays forbidden');
  assert.equal(isRestartContinuation('red', 'red', WIN + 1, WIN), false);
  assert.equal(isRestartContinuation(null, 'red', 1_000, WIN), false);
});

/* ─── (g) the persisted state genuinely survives a restart ──────────────── */

test('redReplayGate (g) — write, then re-read with a FRESH instance (simulated restart)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-persist-'));
  try {
    const path = join(dir, 'broadcast-red-replay.json');

    // ── process 1: a red is announced successfully.
    const before = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    assert.equal(before.state(), null, 'first boot has no evidence');
    before.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    assert.ok(existsSync(path), 'the announcement must reach DISK, not just memory');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      lastRedAnnouncedAtMs: T0,
      voicedFingerprint: FP_STANDING,
      activeFingerprints: [FP_STANDING],
      lastPlayedLevel: 'red',
    });

    // ── process 2 (the restart): a brand-new instance, nothing shared in memory.
    const after = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    assert.deepEqual(after.state(), {
      lastRedAnnouncedAtMs: T0, voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], lastPlayedLevel: 'red',
    });

    // The standing fault re-appears 90 s into the new boot, 5 min after it was
    // last spoken → suppressed. This is the whole feature.
    assert.equal(
      after.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 90_000, nowMs: T0 + 5 * 60 * 1000 }),
      true,
    );
    // ★ and a NEW critical in that same post-restart instance still fires.
    assert.equal(
      after.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING, FP_THERMAL], msSinceBoot: 90_000, nowMs: T0 + 5 * 60 * 1000 }),
      false,
    );
    // ★ as does the SAME id carrying a different error code.
    assert.equal(
      after.shouldSuppress({ observed: 'red', voicedFingerprint: FP_OTHER_CODE, activeFingerprints: [FP_OTHER_CODE], msSinceBoot: 90_000, nowMs: T0 + 5 * 60 * 1000 }),
      false,
    );
    // ...and the same fault an hour later fires again.
    assert.equal(
      after.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 90_000, nowMs: T0 + 60 * 60 * 1000 }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redReplayGate (g) — five restarts in four hours: the live 2026-08-03 sequence klaxons ONCE per 30 min', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-deploys-'));
  try {
    const path = join(dir, 'broadcast-red-replay.json');
    // Deploy offsets (minutes) from the first announcement, five deploys / 4 h.
    const deploys = [0, 12, 35, 47, 130];
    let announces = 0;
    for (const min of deploys) {
      const now = T0 + min * 60 * 1000;
      // a fresh process per deploy — the state file is the only channel
      const gate = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
      const mute = gate.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 90_000, nowMs: now });
      if (!mute) {
        announces += 1;
        gate.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: now });
      }
    }
    // t=0 announces; +12 muted; +35 announces (>30 since t=0); +47 muted;
    // +130 announces. Five klaxons become three, and none is ever LOST — the
    // operator still gets a periodic reminder that the fault is standing.
    assert.equal(announces, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ─── recording rule: only a VERIFIED dispatch buys silence ─────────────── */

test('redReplayGate — only a VERIFIED-successful RED dispatch is recorded', () => {
  assert.equal(isRecordableRedAnnounce('red', true), true);
  assert.equal(isRecordableRedAnnounce('red', false), false, '★ a partial/failed dispatch was maybe never heard');
  assert.equal(isRecordableRedAnnounce('yellow', true), false);
  assert.equal(isRecordableRedAnnounce('green', true), false);
});

test('redReplayGate — noteRedAnnounced overwrites the timestamp, the voiced fault AND the active set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-replay-overwrite-'));
  try {
    const path = join(dir, 's.json');
    const gate = createRedReplayGate({ statePath: path, windowMs: WIN, minGapMs: GAP });
    gate.noteRedAnnounced({ voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], nowMs: T0 });
    gate.noteRedAnnounced({ voicedFingerprint: FP_THERMAL, activeFingerprints: [FP_STANDING, FP_THERMAL], nowMs: T0 + 1000 });
    assert.deepEqual(gate.state(), {
      lastRedAnnouncedAtMs: T0 + 1000,
      voicedFingerprint: FP_THERMAL,
      activeFingerprints: [FP_STANDING, FP_THERMAL],
      lastPlayedLevel: 'red',
    });
    // the thermal fault is now the spoken one, and the pair is known
    assert.equal(
      gate.shouldSuppress({ observed: 'red', voicedFingerprint: FP_THERMAL, activeFingerprints: [FP_STANDING, FP_THERMAL], msSinceBoot: 1000, nowMs: T0 + 2000 }),
      true,
    );
    // ...but the OLD spoken fault is no longer what would be said → announce
    assert.equal(
      gate.shouldSuppress({ observed: 'red', voicedFingerprint: FP_STANDING, activeFingerprints: [FP_STANDING], msSinceBoot: 1000, nowMs: T0 + 2000 }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redReplayGate — v1.78.0 supersedes the v1.64.0 30-minute stopwatch', () => {
  // The 30-minute default was measured to be timing luck: 2026-08-13 restart 2
  // missed a full replay by 27.5 s, and the 08-15 reboot replayed a 3-week-old
  // fault in full. Identity decides now; the env var restores the reminder.
  if (process.env.BROADCAST_RED_REPLAY_MIN_GAP_MS == null) {
    assert.equal(RED_REPLAY_MIN_GAP_MS, Infinity);
  }
});

test('★ a MISWIRED gate (handed bare alert IDS) degrades to a NO-OP, never to a mute', () => {
  // The exact defect this module exists to prevent, one word away at the call
  // site. Bare ids are not fingerprints, so sameness can never be proven.
  assert.equal(isFingerprint('dpu-err-GBC0314'), false, 'a bare id is not a fingerprint');
  assert.equal(isFingerprint(FP_STANDING), true);
  assert.equal(isFingerprint(alertFingerprint({ id: 'x', title: 'y' })), true, 'an absent fault code still yields 3 fields');
  // Both guards are load-bearing and are checked independently.
  assert.equal(
    isRedReplaySuppressed({
      observed: 'red',
      voicedFingerprint: 'dpu-err-GBC0314',            // ← an ID, not a fingerprint
      activeFingerprints: ['dpu-err-GBC0314'],
      persisted: announced({ voiced: 'dpu-err-GBC0314', active: ['dpu-err-GBC0314'] }),
      msSinceBoot: 90_000, nowMs: T0 + 60_000, windowMs: WIN, minGapMs: GAP,
    }),
    false,
    '★ a bare id as the VOICED identity ⇒ always announce',
  );
  assert.equal(
    isRedReplaySuppressed({
      observed: 'red',
      voicedFingerprint: 'dpu-err-GBC0314',            // ← only the VOICED one is an id
      activeFingerprints: [FP_STANDING],               //    the active list is well-formed
      persisted: announced({ voiced: 'dpu-err-GBC0314', active: ['dpu-err-GBC0314', FP_STANDING] }),
      msSinceBoot: 90_000, nowMs: T0 + 60_000, windowMs: WIN, minGapMs: GAP,
    }),
    false,
    '★ the VOICED guard alone must be sufficient — everything else here matches',
  );
  assert.equal(
    isRedReplaySuppressed({
      observed: 'red',
      voicedFingerprint: FP_STANDING,                  // valid, and it matches
      activeFingerprints: ['dpu-err-GBC0314'],         // ← only the ACTIVE list is ids
      persisted: announced({ voiced: FP_STANDING, active: [FP_STANDING, 'dpu-err-GBC0314'] }),
      msSinceBoot: 90_000, nowMs: T0 + 60_000, windowMs: WIN, minGapMs: GAP,
    }),
    false,
    '★ the ACTIVE guard alone must be sufficient too',
  );
  // ...and such a record cannot even be persisted and re-read.
  assert.equal(parseRedAnnounceState({
    lastRedAnnouncedAtMs: T0, voicedFingerprint: 'dpu-err-GBC0314', activeFingerprints: ['dpu-err-GBC0314'], lastPlayedLevel: 'red',
  }), null);
});

test('★ state written by the earlier bare-id draft does NOT parse (migration fails open)', () => {
  assert.equal(
    parseRedAnnounceState({ lastRedAnnouncedAtMs: T0, criticalIds: ['dpu-err-GBC0314'] }),
    null,
    'the first restart after the upgrade announces, then records the new shape',
  );
});

test('redReplayGate — describeFingerprint renders a log-safe, human-readable form', () => {
  assert.equal(describeFingerprint(FP_STANDING), 'dpu-err-GBC0314 / Battery protection fault / err533');
  assert.equal(describeFingerprint(FP_THERMAL), 'thermal-runaway-core1 / Pack over-temperature');
});

/* ─── the identity source: conditionFromAlerts must publish the right ids ── */

test('conditionFromAlerts — criticalIds carries the identity of the counted criticals', () => {
  const r = conditionFromAlerts([
    { id: 'thermal-core2', severity: 'critical', category: 'Thermal', device: 'core 2', title: 't', detail: 'd' },
    { id: 'bat-protect-core3-pack1', severity: 'critical', category: 'Battery', device: 'core 3', title: 't', detail: 'd' },
    { id: 'warn-1', severity: 'warning', category: 'Battery', device: 'core 1', title: 't', detail: 'd' },
  ] as any);
  assert.equal(r.level, 'red');
  assert.equal(r.crit, 2);
  assert.deepEqual(r.criticalIds, ['bat-protect-core3-pack1', 'thermal-core2'], 'sorted → order-stable across ticks');
});

test('conditionFromAlerts — ids EXCLUDED from the condition are excluded from criticalIds too', () => {
  // These ids never raise the level (dedicated announce paths / non-annunciating),
  // so they must not enter the gate's identity either — otherwise a fault the
  // condition broadcast never spoke could count as "already announced".
  const r = conditionFromAlerts([
    { id: 'bat-protect-core3-pack1', severity: 'critical', category: 'Battery', device: 'core 3', title: 't', detail: 'd' },
    { id: 'backup-soc-10', severity: 'critical', category: 'Battery', device: 'pool', title: 't', detail: 'd' },
    { id: 'shp2-below-reserve', severity: 'critical', category: 'SHP2', device: 'shp2', title: 't', detail: 'd' },
    { id: 'forecast-runtime-x', severity: 'critical', category: 'Battery', device: 'pool', title: 't', detail: 'd' },
    { id: 'system-audible-unreachable', severity: 'critical', category: 'Connectivity', device: 'ma', title: 't', detail: 'd' },
    { id: 'muted-crit', severity: 'critical', category: 'Thermal', device: 'core 5', title: 't', detail: 'd', annunciate: false },
  ] as any);
  assert.deepEqual(r.criticalIds, ['bat-protect-core3-pack1']);
  assert.equal(r.crit, 1);
  assert.deepEqual(r.criticalFingerprints, [alertFingerprint({ id: 'bat-protect-core3-pack1', title: 't' })]);
});

test('conditionFromAlerts — no criticals → empty criticalIds (a yellow/green can never seed the red gate)', () => {
  assert.deepEqual(conditionFromAlerts([]).criticalIds, []);
  assert.deepEqual(conditionFromAlerts([]).criticalFingerprints, []);
  assert.deepEqual(
    conditionFromAlerts([
      { id: 'w', severity: 'warning', category: 'Battery', device: 'core 1', title: 't', detail: 'd' },
    ] as any).criticalFingerprints,
    [],
  );
});

test('★ conditionFromAlerts — criticalFingerprints separate what criticalIds CANNOT', () => {
  const at = (title: string, fault: string) => conditionFromAlerts([
    { id: 'dpu-err-GBC0314', severity: 'critical', category: 'Battery', device: 'Core 3', title, fault, detail: 'd' },
  ] as any);
  const a = at('Battery protection fault', 'err533');
  const b = at('Inverter error code', 'err307');
  assert.deepEqual(a.criticalIds, b.criticalIds, '★ the bare ids are IDENTICAL — this is the defect');
  assert.notDeepEqual(a.criticalFingerprints, b.criticalFingerprints, '★ the fingerprints are not');
});

test('★ conditionFromAlerts — criticalFingerprints are STABLE while the detail drifts', () => {
  const at = (detail: string) => conditionFromAlerts([
    { id: 'vdiff-crit-SN-1', severity: 'critical', category: 'Battery', device: 'Core 3', title: 'Cell imbalance', detail },
  ] as any).criticalFingerprints;
  assert.deepEqual(at('cell spread 92 mV'), at('cell spread 141 mV'), '★ otherwise the gate is a silent no-op');
});

/* ─── v1.78.0 — identity replaces the stopwatch ───────────────────────────── */

test('v1.78.0 default: RED_REPLAY_MIN_GAP_MS is Infinity (announced since fault began)', () => {
  // CI runs with the env var unset; an env-set value restores the timed reminder.
  assert.equal(RED_REPLAY_MIN_GAP_MS, Infinity);
});

test('the 27.5-second-margin case: an identical fault suppresses at ANY gap', () => {
  // 2026-08-13: restart 2 escaped a full 56.7s klaxon by 27.5s of image-pull
  // luck (29m32s vs the old 30m bar). And the 08-15 reboot at a 44h gap
  // replayed it in full. Identity now decides; elapsed time does not.
  const fp = alertFingerprint({ id: 'dpu-err-Y711FAB59J234000', title: 'Battery protection fault', fault: 'err533' });
  for (const gapMs of [29.5 * 60_000, 31 * 60_000, 44 * 3_600_000, 21 * 24 * 3_600_000]) {
    assert.equal(isRedReplaySuppressed({
      observed: 'red', voicedFingerprint: fp, activeFingerprints: [fp],
      persisted: { lastRedAnnouncedAtMs: 1_000_000, voicedFingerprint: fp, activeFingerprints: [fp], lastPlayedLevel: 'red' },
      msSinceBoot: 60_000, nowMs: 1_000_000 + gapMs, windowMs: 10 * 60_000, minGapMs: RED_REPLAY_MIN_GAP_MS,
    }), true, `gap ${gapMs}ms must suppress an identical, already-announced fault`);
  }
});

test('an env-style FINITE gap still enforces the timed reminder', () => {
  const fp = alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err533' });
  const base = { observed: 'red' as const, voicedFingerprint: fp, activeFingerprints: [fp],
    persisted: { lastRedAnnouncedAtMs: 1_000_000, voicedFingerprint: fp, activeFingerprints: [fp], lastPlayedLevel: 'red' as const },
    msSinceBoot: 60_000, windowMs: 10 * 60_000, minGapMs: 30 * 60_000 };
  assert.equal(isRedReplaySuppressed({ ...base, nowMs: 1_000_000 + 29 * 60_000 }), true);
  assert.equal(isRedReplaySuppressed({ ...base, nowMs: 1_000_000 + 31 * 60_000 }), false, 'past an explicit gap, the reminder replays');
});

test('identity still forces an announce at ANY gap: changed fault / new sibling / escalation / future clock', () => {
  const spoken = alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err533' });
  const changed = alertFingerprint({ id: 'dpu-err-X', title: 'Battery protection fault', fault: 'err461' });
  const persisted = { lastRedAnnouncedAtMs: 1_000_000, voicedFingerprint: spoken, activeFingerprints: [spoken], lastPlayedLevel: 'red' as const };
  const base = { observed: 'red' as const, msSinceBoot: 60_000, nowMs: 1_000_000 + 7 * 24 * 3_600_000, windowMs: 10 * 60_000, minGapMs: Infinity };
  // a different error code on the same id is a DIFFERENT fault
  assert.equal(isRedReplaySuppressed({ ...base, voicedFingerprint: changed, activeFingerprints: [changed], persisted }), false);
  // a new critical alongside the spoken one
  assert.equal(isRedReplaySuppressed({ ...base, voicedFingerprint: spoken, activeFingerprints: [spoken, changed], persisted }), false);
  // last played below red = escalation
  assert.equal(isRedReplaySuppressed({ ...base, voicedFingerprint: spoken, activeFingerprints: [spoken], persisted: { ...persisted, lastPlayedLevel: 'yellow' } }), false);
  // future-dated evidence (clock stepped back) can never suppress
  assert.equal(isRedReplaySuppressed({ ...base, nowMs: 999_000, voicedFingerprint: spoken, activeFingerprints: [spoken], persisted }), false);
});
