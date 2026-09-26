/**
 * v1.186.0 — two alert-monitor fixes from the 2026-09-24 production log review.
 *
 *  (1) AUTO-TUNE SCOPE. familyOf() stops at the serial, so a bench spare's or an off-panel
 *      Core's non-annunciating alerts shared a rollup with the home Cores' — and their
 *      volume alone demoted home-Core vdiff-warn pushes to "[Low]" (Rule 4) and silenced
 *      peer-voldiff. The rollups now count annunciating episodes only, the pre-scope log
 *      lines are not replayed, a latch derived at a lower tier no longer eats a warning,
 *      and every suppressed or demoted dispatch names its rule and counts.
 *
 *  (2) ALARMS DO NOT WAIT ON THE ANALYTICS WORKER. The tick used to await four worker
 *      reports (and the NWS fetch) before computing ANY alarm, and awaited four more per
 *      new pack alert (captureLrFeatures) before dispatching. Live alarms now publish
 *      before any wait; worker-served alerts come from a last-good feed with a short
 *      budget and are CARRIED, never cleared, when the worker is slow.
 *
 * The integration tests at the bottom drive the real monitor (startAlertMonitor) with an
 * injected analytics client, so a hung worker is a promise that never settles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { AlertActionStats } from '../src/alertMonitor.js';
import type { TelemetryEntry } from '../src/alertTelemetry.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// Every app module reads its sidecar paths (DB_PATH-relative) and these knobs at import,
// so they are set first and every app import below is dynamic.
const tmp = mkdtempSync(join(tmpdir(), 'ef-am-1186-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '200';
process.env.ALERT_FEED_BUDGET_MS = '1500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;

const {
  applySilencingRules, autoTuneDispatchVerdict, autoTuneCounts, autoTuneClearCounts,
  replayTelemetryEvents, liftedAutoTuneVerdicts, createLastGoodFeed, bootRetrackDecision,
  startAlertMonitor, ALERT_FEED_BUDGET_MS,
} = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { upsertFamilyMeta } = await import('../src/alertTelemetry.js');
const { restampAlertOnset, syncAlertOnsets, getAlertOnset } = await import('../src/alertOnset.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});
// A regression here is a HANG (a read that never settles, a tick that never ends), and the
// runner waits on a pending test forever; these turn it into a bounded failure.
const FEED_TEST_TIMEOUT_MS = 5_000;
const MONITOR_TEST_TIMEOUT_MS = 20_000;

function stats(over: Partial<AlertActionStats>): AlertActionStats {
  return {
    familyKey: 'fam', alertId: 'fam-X', title: 'Fam', severity: 'warning', category: 'Battery',
    riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
    downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
    neverClearedCount: 0, lastSeenAt: null,
    ...over,
  };
}

function alert(id: string, severity: Alert['severity'], over: Partial<Alert> = {}): Alert {
  return { id, severity, category: 'Battery', device: 'System', title: `Test ${id}`, detail: 'test', source: 'threshold', ...over };
}

/* ══ (1) auto-tune scope ═════════════════════════════════════════════════════ */

test('★★ the 09-23 peer-voldiff shape: an info-derived silence no longer eats a WARNING member', () => {
  // The family's last event was an info rise, so Rule 4 latched `downgradedSilenced`. The
  // same pack escalated to warning and the old dispatch dropped it with no log line.
  const t = stats({ familyKey: 'peer-voldiff', severity: 'info', riseCount: 365, shortClearsCount: 120, neverClearedCount: 9 });
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, true, 'precondition: the family flag reads "silenced"');
  const v = autoTuneDispatchVerdict(t, { severity: 'warning' }, 'new');
  assert.notEqual(v.action, 'suppress', 'a warning member is judged at warning, not at the info exemplar');
  assert.equal(v.action, 'demote', 'at warning tier the same volume is Rule 4 DEMOTE (still pushed, as [Low])');
  assert.equal(v.ratedAt, 'warning');
  assert.match(v.rule ?? '', /Rule 4 \(high-volume churn\)/);
  assert.match(v.basis ?? '', /365 rises, 120 short-clears \(33%\), 9 long-active \(2%\)/);
});

test('an info member of an info-silenced family is still suppressed, and says why', () => {
  const t = stats({ familyKey: 'peer-voldiff', severity: 'info', riseCount: 365, shortClearsCount: 120, neverClearedCount: 9 });
  applySilencingRules(t);
  const v = autoTuneDispatchVerdict(t, { severity: 'info' }, 'new');
  assert.equal(v.action, 'suppress');
  assert.match(v.rule ?? '', /Rule 4/);
  assert.equal(v.ratedAt, 'info');
});

test('Rule 3 chronic noise suppresses a warning, a resolve is never demoted, a critical always passes', () => {
  const chronic = stats({ familyKey: 'chronic', severity: 'warning', riseCount: 20, neverClearedCount: 12 });
  applySilencingRules(chronic);
  const v = autoTuneDispatchVerdict(chronic, { severity: 'warning' }, 'new');
  assert.equal(v.action, 'suppress');
  assert.match(v.rule ?? '', /Rule 3 \(chronic noise\)/);

  const churn = stats({ familyKey: 'vdiff-warn', severity: 'warning', riseCount: 265, shortClearsCount: 74, neverClearedCount: 9 });
  applySilencingRules(churn);
  assert.equal(autoTuneDispatchVerdict(churn, { severity: 'warning' }, 'new').action, 'demote');
  assert.equal(autoTuneDispatchVerdict(churn, { severity: 'warning' }, 'resolved').action, 'pass', 'demotion is for a fire only');
  assert.equal(autoTuneDispatchVerdict(churn, { severity: 'critical' }, 'new').action, 'pass');
  assert.equal(autoTuneDispatchVerdict(undefined, { severity: 'warning' }, 'new').action, 'pass', 'no rollup yet: pass');
  const energy = stats({ familyKey: 'soc-low', severity: 'warning', riseCount: 400, shortClearsCount: 390 });
  assert.equal(autoTuneDispatchVerdict(energy, { severity: 'warning' }, 'new').action, 'pass', 'energy-state families are exempt');
});

test('★ the verdict is never MORE restrictive than the old family-flag read (property sweep)', () => {
  // The old dispatch: suppress iff (downgradedSilenced || chronicNoiseSilenced), demote iff
  // warningDemotedToInfo on a warning 'new'. Rated at a higher tier the rules can only lift.
  const rank = { suppress: 2, demote: 1, pass: 0 } as const;
  for (const famSev of ['info', 'warning'] as const) {
    for (const alertSev of ['info', 'warning'] as const) {
      for (const rises of [4, 9, 12, 149, 160, 400]) {
        for (const shortFrac of [0, 0.5, 0.75, 0.85, 1]) {
          for (const neverFrac of [0, 0.1, 0.3, 0.6]) {
            const t = stats({
              familyKey: 'sweep', severity: famSev, riseCount: rises,
              shortClearsCount: Math.round(rises * shortFrac), neverClearedCount: Math.round(rises * neverFrac),
            });
            applySilencingRules(t);
            const old = (t.downgradedSilenced || t.chronicNoiseSilenced) ? 'suppress'
              : (t.warningDemotedToInfo && alertSev === 'warning') ? 'demote' : 'pass';
            const now = autoTuneDispatchVerdict(t, { severity: alertSev }, 'new').action;
            assert.ok(rank[now] <= rank[old], `fam ${famSev} alert ${alertSev} rises ${rises}: ${old} → ${now}`);
            if (alertSev === famSev || alertSev === 'info') assert.equal(now, old, 'at or below the exemplar tier the read is unchanged');
          }
        }
      }
    }
  }
});

test('applySilencingRules names the rules that fired (and still mutates the flags)', () => {
  const t = stats({ severity: 'warning', riseCount: 200, shortClearsCount: 170, neverClearedCount: 10 });
  const hits = applySilencingRules(t);
  assert.deepEqual(hits.map((h) => h.rule), ['Rule 2 (warning short-clears)', 'Rule 4 (high-volume churn)']);
  assert.ok(hits.every((h) => h.effect === 'demote'));
  assert.equal(t.warningDemotedToInfo, true);
});

test('★★ a muted episode feeds neither end of the rollup; a counted rise always pairs its clear', () => {
  assert.equal(autoTuneCounts({ annunciate: false }), false, 'a bench spare / off-panel / balancing-muted alert');
  assert.equal(autoTuneCounts({}), true);
  assert.equal(autoTuneCounts({ annunciate: true }), true);
  // Rise counted in this process: the clear pairs it even if the alert ended muted.
  assert.equal(autoTuneClearCounts({ rollupScope: 'rise', alert: { annunciate: false } }), true);
  // Re-tracked at boot (rise counted by a previous process under an unknown scope): the
  // clear counts only while it still annunciates — an off-panel Core demoted three ticks
  // after boot must not land a clear in the home family.
  assert.equal(autoTuneClearCounts({ rollupScope: 'retrack', alert: { annunciate: false } }), false);
  assert.equal(autoTuneClearCounts({ rollupScope: 'retrack', alert: {} }), true);
  // Muted as it rose: never.
  assert.equal(autoTuneClearCounts({ rollupScope: undefined, alert: {} }), false);
});

test('★★ the polluted persisted log: pre-scope lines are not replayed, so the spare-driven latches lift', () => {
  const T = Date.now() - 86_400_000;
  const legacy: TelemetryEntry[] = [];
  // vdiff-warn's live shape: 265 rises (a bench spare contributed most), 74 short, 9 long.
  for (let i = 0; i < 265; i++) legacy.push({ familyKey: 'vdiff-warn', alertId: `vdiff-warn-COREXXX00XXX0004-${1 + (i % 4)}`, event: 'rise', ts: T + i });
  for (let i = 0; i < 74; i++) legacy.push({ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0004-1', event: 'shortClear', ts: T + 300 + i, durationMs: 60_000 });
  for (let i = 0; i < 9; i++) legacy.push({ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0002-4', event: 'longActive', ts: T + 400 + i, durationMs: 5 * 3_600_000 });
  // peer-voldiff: 365 rises at an info exemplar → silenced.
  for (let i = 0; i < 365; i++) legacy.push({ familyKey: 'peer-voldiff', alertId: 'peer-voldiff-COREXXX00XXX0004-1', event: 'rise', ts: T + 500 + i });
  // Post-fix, annunciating-only evidence for the home Cores.
  const scoped: TelemetryEntry[] = [];
  for (let i = 0; i < 20; i++) scoped.push({ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0002-4', event: 'rise', ts: T + 1000 + i, scope: 'annunciating' });
  for (let i = 0; i < 6; i++) scoped.push({ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0002-4', event: 'shortClear', ts: T + 1100 + i, durationMs: 90_000, scope: 'annunciating' });
  const meta = {
    'vdiff-warn': { title: 'Cell imbalance', severity: 'warning', category: 'Battery', alertId: 'vdiff-warn-COREXXX00XXX0004-1' },
    'peer-voldiff': { title: 'Pack voltage outlier', severity: 'info', category: 'Battery', alertId: 'peer-voldiff-COREXXX00XXX0004-1' },
  };
  const events = [...legacy, ...scoped];

  const before = replayTelemetryEvents(events, meta, { includeLegacy: true });
  assert.equal(before.rollups.get('vdiff-warn')!.warningDemotedToInfo, true, 'precondition: the pooled log demotes vdiff-warn');
  assert.equal(before.rollups.get('peer-voldiff')!.downgradedSilenced, true, 'precondition: and silences peer-voldiff');

  const r = replayTelemetryEvents(events, meta);
  assert.equal(r.replayed, scoped.length);
  assert.equal(r.legacySkipped, legacy.length);
  assert.deepEqual([...r.legacyFamilies].sort(), ['peer-voldiff', 'vdiff-warn']);
  const vw = r.rollups.get('vdiff-warn')!;
  assert.equal(vw.riseCount, 20, 'only the annunciating evidence is counted');
  assert.equal(vw.shortClearsCount, 6);
  assert.equal(vw.warningDemotedToInfo, false, 'the demotion lifts on the next boot');
  assert.equal(r.rollups.has('peer-voldiff'), false, 'no scoped evidence yet: no latch at all');

  const lifted = liftedAutoTuneVerdicts(before.rollups, r.rollups);
  assert.equal(lifted.length, 2);
  assert.match(lifted[0], /^peer-voldiff \(push silence; was 365 rises/);
  assert.match(lifted[1], /^vdiff-warn \(warning→info demotion; was 285 rises.*scoped 20 rises, 6 short-clears/);
});

test('a scoped-only log replays exactly as before (the counting itself is unchanged)', () => {
  const T = Date.now() - 3_600_000;
  const ev: TelemetryEntry[] = [
    { familyKey: 'pack-hot', alertId: 'pack-hot-COREXXX00XXX0001-2', event: 'rise', ts: T, scope: 'annunciating' },
    { familyKey: 'pack-hot', alertId: 'pack-hot-COREXXX00XXX0001-2', event: 'shortClear', ts: T + 1, durationMs: 1000, scope: 'annunciating' },
    { familyKey: 'pack-hot', alertId: 'pack-hot-COREXXX00XXX0001-3', event: 'longActive', ts: T + 2, durationMs: 3000, scope: 'annunciating' },
  ];
  const r = replayTelemetryEvents(ev, {});
  const t = r.rollups.get('pack-hot')!;
  assert.equal(t.riseCount, 1);
  assert.equal(t.shortClearsCount, 1);
  assert.equal(t.neverClearedCount, 1);
  assert.equal(t.medianDurationMs, 2000);
  assert.equal(t.longestDurationMs, 3000);
  assert.equal(t.alertId, 'pack-hot-COREXXX00XXX0001-3', 'no sidecar: the exemplar tracks the last event');
  assert.equal(r.legacySkipped, 0);
});

/* ══ (2) the last-good feed ══════════════════════════════════════════════════ */

test('★★ a hung first fetch settles within the budget as UNKNOWN (null), and says so once', { timeout: FEED_TEST_TIMEOUT_MS }, async () => {
  const logs: string[] = [];
  const f = createLastGoodFeed<Alert[]>('curtailmentAlerts', (m) => logs.push(m));
  const t0 = Date.now();
  const r = await f.read(() => never(), 60);
  assert.ok(Date.now() - t0 < 1000, 'bounded by the budget');
  assert.equal(r.value, null, 'no value is not an empty list');
  assert.equal(r.fresh, false);
  assert.equal(f.warm(), false);
  assert.match(r.error ?? '', /60 ms budget/);
  await f.read(() => never(), 20);
  assert.equal(logs.filter((l) => /has no value yet/.test(l)).length, 1, 'logged once, not per tick');
  assert.match(logs[0], /UNKNOWN this pass, not cleared/);
});

test('★★★ after a delivery, a timed-out or failed fetch CARRIES the last good value — never "cleared"', { timeout: FEED_TEST_TIMEOUT_MS }, async () => {
  const logs: string[] = [];
  const f = createLastGoodFeed<Alert[]>('curtailmentAlerts', (m) => logs.push(m));
  const good = [alert('curtail-carry', 'warning')];
  const r1 = await f.read(async () => good, 100);
  assert.equal(r1.fresh, true);
  assert.equal(r1.firstDelivery, true);
  assert.deepEqual(r1.value?.map((a) => a.id), ['curtail-carry']);

  const r2 = await f.read(() => never(), 30);
  assert.equal(r2.fresh, false);
  assert.equal(r2.firstDelivery, false, 'first delivery is reported exactly once');
  assert.deepEqual(r2.value?.map((a) => a.id), ['curtail-carry'], 'the timed-out read carries the alert');
  assert.match(logs.join('\n'), /carrying its last good value .* its alerts are held, not cleared/);

  const r3 = await f.read(() => Promise.reject(new Error('analytics worker exited')), 30);
  // The hung fetch from r2 is still in flight, so r3 JOINS it (one request at a time);
  // either way the answer is the carried value.
  assert.deepEqual(r3.value?.map((a) => a.id), ['curtail-carry']);
});

test('a failed fetch carries too, and a sync throw does not wedge the feed', { timeout: FEED_TEST_TIMEOUT_MS }, async () => {
  const f = createLastGoodFeed<number>('x');
  await f.read(async () => 7, 100);
  const bad = await f.read(() => Promise.reject(new Error('worker exited')), 100);
  assert.equal(bad.value, 7);
  assert.match(bad.error ?? '', /failed — worker exited/);
  const sync = await f.read(() => { throw new Error('analytics client not initialized'); }, 100);
  assert.equal(sync.value, 7);
  const later = await f.read(async () => 8, 100);
  assert.equal(later.value, 8, 'the slot was released: a later read fetches again');
  assert.equal(later.fresh, true);
});

test('★ one request at a time: a stalled worker is joined, not queued behind', { timeout: FEED_TEST_TIMEOUT_MS }, async () => {
  const f = createLastGoodFeed<number>('x');
  let calls = 0;
  let release!: (v: number) => void;
  const start = () => { calls++; return new Promise<number>((r) => { release = r; }); };
  await f.read(start, 20);
  await f.read(start, 20);
  await f.read(start, 20);
  assert.equal(calls, 1, 'three ticks, one worker request');
  release(5);
  await sleep(5);
  const r = await f.read(async () => 6, 50);
  assert.equal(r.fresh, true);
  assert.equal(r.firstDelivery, true, 'the background landing is delivered on the next read');
  assert.ok(r.value === 5 || r.value === 6);
});

test('★ every value is a private copy: a mute stamped on one tick does not persist into the next', { timeout: FEED_TEST_TIMEOUT_MS }, async () => {
  const f = createLastGoodFeed<Alert[]>('baselineAlerts');
  await f.read(async () => [alert('baseline-ch1_w-COREXXX00XXX0001', 'warning')], 100);
  const a = f.peek()!;
  a[0].annunciate = false; // what the off-panel gate does to the tick's alert objects
  const b = await f.read(() => never(), 20);
  assert.equal(b.value![0].annunciate, undefined, 'a Core re-armed on the roster must not stay muted');
  assert.equal(f.peek()![0].annunciate, undefined);
});

test('bootRetrackDecision: a feed\'s first delivery re-tracks only what predates the boot', () => {
  const bootMs = 1_000_000;
  // Tick 1: unchanged from isBootRetrack + bootSeedNotified.
  assert.deepEqual(bootRetrackDecision({ firstRun: true, firstFeedDelivery: false, priorOnsetMs: bootMs - 5, bootMs }), { retrack: true, seedAsBoot: true });
  assert.deepEqual(bootRetrackDecision({ firstRun: true, firstFeedDelivery: false, priorOnsetMs: undefined, bootMs }), { retrack: false, seedAsBoot: true });
  // A feed delivering late: a pre-restart condition is a re-track (no rise, no re-push)…
  assert.deepEqual(bootRetrackDecision({ firstRun: false, firstFeedDelivery: true, priorOnsetMs: bootMs - 5, bootMs }), { retrack: true, seedAsBoot: true });
  // …but one that arose after the restart is a genuine rise and pushes normally.
  assert.deepEqual(bootRetrackDecision({ firstRun: false, firstFeedDelivery: true, priorOnsetMs: undefined, bootMs }), { retrack: false, seedAsBoot: false });
  assert.deepEqual(bootRetrackDecision({ firstRun: false, firstFeedDelivery: true, priorOnsetMs: bootMs + 5, bootMs }), { retrack: false, seedAsBoot: false });
  // Steady state.
  assert.deepEqual(bootRetrackDecision({ firstRun: false, firstFeedDelivery: false, priorOnsetMs: bootMs - 5, bootMs }), { retrack: false, seedAsBoot: false });
});

test('syncAlertOnsets({ prune: false }) keeps an absent id\'s onset (unknown is not cleared)', () => {
  const T = Date.now() - 10_000;
  syncAlertOnsets(['onset-keep-A', 'onset-keep-B'], T);
  syncAlertOnsets(['onset-keep-A'], T + 1000, { prune: false });
  assert.equal(getAlertOnset('onset-keep-B'), T, 'held while its feed is cold');
  assert.equal(getAlertOnset('onset-keep-A'), T);
  syncAlertOnsets(['onset-keep-A'], T + 2000);
  assert.equal(getAlertOnset('onset-keep-B'), undefined, 'pruned once the set is known again');
});

test('★ BRIDGE: the boot orphan sweep waits for the cold feed that OWNS an id before resolving it', () => {
  // SOURCE PIN, deliberately: the sweep first runs LEARNED_RESOLVE_GRACE_MS (10 min) after
  // boot, which no test drives. Without the hold, a worker-served id that was pushed before
  // the restart and whose feed has not delivered yet is absent from the set and gets
  // "Resolved: … cleared while the add-on was restarting" on no evidence.
  // v1.186.0 — scoped to the ids that feed owns (coldFeedOwns): a live-snapshot id's absence is
  // evidence, and holding it too dropped its "Resolved:" silently at the hold deadline.
  const AM = readFileSync(resolve(import.meta.dirname, '../src/alertMonitor.ts'), 'utf8');
  const start = AM.indexOf('orphanSweepDone && now - bootMs');
  assert.ok(start > 0, 'orphan sweep guard located');
  const block = AM.slice(start, AM.indexOf('boot reconcile', start));
  const cold = block.indexOf('const feedsCold = !alertFeedsWarm();');
  assert.ok(cold > 0, 'the cold-feed state is read');
  assert.ok(cold < block.indexOf('orphanedNotifiedIds({'), 'before the sweep runs');
  // Through the UNEVALUABLE leg, so the held orphans keep the sweep open (hold.length > 0)
  // and are resolved once the feeds deliver — or dropped at the deadline, never resolved blind.
  assert.match(block, /unevaluable: \(id, rec\) => coldFeedOwns\(id\) \|\| fallingEdgeFrozenByEvidence\(\{/);
});

test('the pure sweep, fed "cold" as unevaluable: an owed orphan is held, never resolved', async () => {
  const { orphanedNotifiedIds } = await import('../src/alertMonitor.js');
  const persisted = new Map([['curtail-orphan-SYS', { ts: Date.now(), sent: true, sev: 'warning' as const }]]);
  const base = {
    persisted, currentIds: new Set<string>(), trackedIds: new Set<string>(),
    notifyResolved: true, minSeverity: 'warning' as const, nowMs: 1_000, holdUntilMs: 2_000,
  };
  assert.deepEqual(orphanedNotifiedIds({ ...base, unevaluable: () => true }), { resolve: [], drop: [], hold: ['curtail-orphan-SYS'] });
  assert.deepEqual(orphanedNotifiedIds({ ...base, nowMs: 3_000, unevaluable: () => true }).drop, ['curtail-orphan-SYS'], 'past the deadline: dropped, not resolved');
  assert.deepEqual(orphanedNotifiedIds({ ...base, unevaluable: () => false }).resolve, ['curtail-orphan-SYS'], 'warm: resolved as before');
});

/* ══ integration: the real monitor, a hung worker ═══════════════════════════ */

type Sent = { title: string; severity: string };

function startMonitor(name: string, opts: {
  store: InstanceType<typeof SnapshotStore>;
  report: (report: string) => Promise<any>;
  stormPrep?: () => Promise<Alert[]>;
  captureLrFeatures?: (...a: any[]) => Promise<any>;
  sent?: Sent[];
  /** v1.186.0 — the store's first poll has settled (default); false leaves the boot gate closed. */
  hydrated?: boolean;
}) {
  // v1.186.0 — these tests start on a hydrated store unless they say otherwise (the boot gate).
  if (opts.hydrated !== false) opts.store.markFirstPollSettled();
  // The per-monitor sidecars are read at start, so each test gets its own.
  process.env.NOTIFY_STATE_PATH = join(tmp, `${name}-notify-state.json`);
  process.env.DIGEST_STATE_PATH = join(tmp, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(tmp, `${name}-cleared.json`);
  const logs: string[] = [];
  const mon = startAlertMonitor(opts.store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: (n: string) => opts.report(n) } as any,
    stormPrep: opts.stormPrep ?? (async () => []),
    captureLrFeatures: (opts.captureLrFeatures ?? (async () => null)) as any,
    ...(opts.sent ? { send: async (_cfg: unknown, msg: { title: string; severity: string }) => { opts.sent!.push({ title: msg.title, severity: msg.severity }); } } : {}),
  });
  return { mon, logs };
}

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<number> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(10);
  }
  return Date.now() - t0;
}

async function stopAndSettle(mon: { stop: () => void }) {
  mon.stop();
  await sleep(250);
}

test('★★★ a worker feed first delivering AFTER tick 1 re-tracks a pre-restart alert: no rise, no re-push', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  // First of the monitor tests: it is the one that depends on a persisted onset surviving
  // tick 1, so no other monitor may be ticking (and pruning the shared sidecar) around it.
  // v1.186.0 — a curtailment-feed family (ALERT_FEED_ID_PREFIXES), so the cold feed owns it.
  const lateId = 'pv-curtailment-late-SYSTEST0001';
  restampAlertOnset(lateId, Date.now() - 60_000); // the condition stood before this boot
  const sent: Sent[] = [];
  let calls = 0;
  const { mon, logs } = startMonitor('late', {
    store: new SnapshotStore(),
    sent,
    report: async (n) => {
      if (n !== 'curtailmentAlerts') return n === 'forecast' ? null : [];
      calls++;
      // The first request outlives tick 1's budget (a cold worker at boot).
      if (calls === 1) await sleep(ALERT_FEED_BUDGET_MS + 200);
      return [alert(lateId, 'warning', { device: 'System' })];
    },
  });
  try {
    await until(() => mon.stats().evalPasses >= 1, 5000, 'tick 1');
    assert.equal(mon.activeAlertIds().includes(lateId), false, 'tick 1: the feed is cold, the alert unknown');
    assert.equal(getAlertOnset(lateId) != null, true, '★ the cold feed did not let tick 1 prune the pre-restart onset');
    await until(() => mon.activeAlertIds().includes(lateId), 5000, 'the late first delivery');
    const passes = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= passes + 3, 5000, 'three more ticks (debounce is 0)');
    assert.ok(logs.some((l) => l.includes(`"${lateId}" re-tracked across a restart`)), 'counted as a re-track');
    assert.equal(sent.filter((s) => s.title.includes(`Test ${lateId}`)).length, 0, 'seeded like a tick-1 alert: no re-push');
    assert.equal(mon.telemetry().some((t) => t.familyKey === 'pv-curtailment-late' && t.riseCount > 0), false, 'no phantom rise');
  } finally {
    await stopAndSettle(mon);
  }
});

test('★★★ a HUNG worker does not delay a threshold alarm: it is published before the budget, and tracked', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  const store = new SnapshotStore();
  store.setDeviceList([{ sn: 'COREXXX00XXX0001', deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 0 } as any]);
  const offlineId = 'offline-COREXXX00XXX0001';
  const t0 = Date.now();
  const { mon, logs } = startMonitor('hung', {
    store,
    report: () => never(),          // every worker report hangs forever
    stormPrep: () => never(),       // and so does the NWS fetch
  });
  try {
    const publishedAfter = await until(() => (store.get().alerts ?? []).some((a) => a.id === offlineId), 5000, 'the offline alarm on screen');
    assert.ok(publishedAfter < ALERT_FEED_BUDGET_MS / 2,
      `the live alarm must publish before any wait on the worker (took ${publishedAfter} ms; budget ${ALERT_FEED_BUDGET_MS} ms)`);
    await until(() => mon.stats().evalPasses >= 1, 5000, 'the first pass to finish');
    const passMs = Date.now() - t0;
    assert.ok(passMs < ALERT_FEED_BUDGET_MS + 2500, `the pass is bounded by the budget, not the worker (${passMs} ms)`);
    assert.ok(mon.activeAlertIds().includes(offlineId), 'tracked, so its push dispatch is not blocked either');
    assert.ok(mon.stats().alertFeeds.every((f) => !f.warm), 'every feed reports cold');
    assert.ok(logs.some((l) => /alert-feed: curtailmentAlerts has no value yet/.test(l)));
    await until(() => mon.stats().evalPasses >= 2, 5000, 'a second pass — the hung requests are joined, not stacked');
  } finally {
    await stopAndSettle(mon);
  }
});

test('★★★ a worker that answers once and then hangs: its alert is CARRIED, not resolved', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  const carryId = 'curtail-carry-SYSTEST0002';
  let curtailCalls = 0;
  const sent: Sent[] = [];
  const st = new SnapshotStore();
  const { mon, logs } = startMonitor('carry', {
    store: st,
    sent,
    report: async (n) => {
      if (n === 'forecast') return null;
      if (n !== 'curtailmentAlerts') return [];
      curtailCalls++;
      if (curtailCalls === 1) return [alert(carryId, 'warning')];
      return never();
    },
  });
  try {
    await until(() => mon.activeAlertIds().includes(carryId), 5000, 'the alert from the first report');
    await until(() => mon.stats().evalPasses >= 3, 10_000, 'two passes on a hung report');
    assert.ok(mon.activeAlertIds().includes(carryId), '★ still tracked — a timed-out report is not a clear');
    assert.ok((st.get().alerts ?? []).some((a) => a.id === carryId), 'and still on screen');
    assert.ok(mon.history().every((c) => c.alert.id !== carryId), 'no cleared record');
    assert.equal(sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:')).length, 0, 'no false "Resolved:" push');
    assert.equal(curtailCalls, 2, 'the hung request is joined by later ticks, not re-sent');
    assert.ok(logs.some((l) => /alert-feed: curtailmentAlerts still running after its \d+ ms budget — carrying its last good value/.test(l)));
    const feed = mon.stats().alertFeeds.find((f) => f.name === 'curtailmentAlerts')!;
    assert.equal(feed.carrying, true);
  } finally {
    await stopAndSettle(mon);
  }
});
test('★★ the feature snapshot runs off the dispatch path: a hung capture blocks nothing', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  const ids = ['cap-a-SYSTEST0003', 'cap-b-SYSTEST0003'];
  let calls = 0;
  let captureCalls = 0;
  const sent: Sent[] = [];
  const { mon } = startMonitor('capture', {
    store: new SnapshotStore(),
    sent,
    captureLrFeatures: () => { captureCalls++; return never(); },
    report: async (n) => {
      if (n === 'forecast') return null;
      if (n !== 'curtailmentAlerts') return [];
      calls++;
      return calls === 1 ? [] : ids.map((id) => alert(id, 'warning'));
    },
  });
  try {
    await until(() => ids.every((id) => mon.activeAlertIds().includes(id)), 5000, 'both new alerts tracked');
    await until(() => sent.filter((s) => ids.some((id) => s.title.includes(`Test ${id}`))).length === 2, 5000, 'both pushed');
    assert.ok(captureCalls >= 2, 'each new alert still gets its capture');
  } finally {
    await stopAndSettle(mon);
  }
});

test('★★ end to end: a muted alert feeds no rollup; an annunciating one feeds both ends, scoped on disk', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  const liveId = 'scope-live-COREXXX00XXX0001';
  const mutedId = 'scope-muted-COREXXX00XXX0004';
  let calls = 0;
  const { mon } = startMonitor('scope', {
    store: new SnapshotStore(),
    report: async (n) => {
      if (n === 'forecast') return null;
      if (n !== 'curtailmentAlerts') return [];
      calls++;
      if (calls === 2) return [alert(liveId, 'warning'), alert(mutedId, 'warning', { annunciate: false })];
      return [];
    },
  });
  try {
    await until(() => calls >= 4 && mon.stats().evalPasses >= 4, 5000, 'rise then clear');
    await until(() => !mon.activeAlertIds().includes(liveId) && !mon.activeAlertIds().includes(mutedId), 5000, 'both cleared');
    const fams = new Map(mon.telemetry().map((t) => [t.familyKey, t]));
    assert.equal(fams.get('scope-live')?.riseCount, 1);
    assert.equal(fams.get('scope-live')?.shortClearsCount, 1);
    assert.equal(fams.has('scope-muted'), false, '★ the muted episode touched neither the rise nor the clear side');
    const lines = readFileSync(join(tmp, 'alert-telemetry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TelemetryEntry);
    const live = lines.filter((e) => e.familyKey === 'scope-live');
    assert.deepEqual(live.map((e) => e.event), ['rise', 'shortClear']);
    assert.ok(live.every((e) => e.scope === 'annunciating'), 'every new line is scoped, so the next boot replays it');
    assert.equal(lines.some((e) => e.familyKey === 'scope-muted'), false);
  } finally {
    await stopAndSettle(mon);
  }
});

test('★★ end to end: a demoted push names its rule and counts; a suppressed one is LOGGED, not silent', { timeout: MONITOR_TEST_TIMEOUT_MS }, async () => {
  // Scoped history on disk, replayed at start: churn-fam is Rule 4 volume, chronic-fam Rule 3.
  // v1.186.0 — ONE append for all 242 lines. One appendFileSync per line (open, write, close)
  // blocked the event loop for 0.6 s unloaded and up to ~60 s under a file scanner and load,
  // before the monitor even started — against this test's own timeout.
  const T = Date.now() - 86_400_000;
  const seed: TelemetryEntry[] = [];
  for (let i = 0; i < 200; i++) seed.push({ familyKey: 'churn-fam', alertId: 'churn-fam-COREXXX00XXX0001', event: 'rise', ts: T + i, scope: 'annunciating' });
  for (let i = 0; i < 10; i++) seed.push({ familyKey: 'churn-fam', alertId: 'churn-fam-COREXXX00XXX0001', event: 'longActive', ts: T + 300 + i, durationMs: 5 * 3_600_000, scope: 'annunciating' });
  for (let i = 0; i < 20; i++) seed.push({ familyKey: 'chronic-fam', alertId: 'chronic-fam-COREXXX00XXX0001', event: 'rise', ts: T + 400 + i, scope: 'annunciating' });
  for (let i = 0; i < 12; i++) seed.push({ familyKey: 'chronic-fam', alertId: 'chronic-fam-COREXXX00XXX0001', event: 'longActive', ts: T + 500 + i, durationMs: 5 * 3_600_000, scope: 'annunciating' });
  appendFileSync(join(tmp, 'alert-telemetry.jsonl'), seed.map((e) => JSON.stringify(e)).join('\n') + '\n');
  upsertFamilyMeta('churn-fam', { title: 'Churn', severity: 'info', category: 'Battery', alertId: 'churn-fam-COREXXX00XXX0001' });
  upsertFamilyMeta('chronic-fam', { title: 'Chronic', severity: 'warning', category: 'Battery', alertId: 'chronic-fam-COREXXX00XXX0001' });
  const churnId = 'churn-fam-COREXXX00XXX0002';
  const chronicId = 'chronic-fam-COREXXX00XXX0002';
  let calls = 0;
  const sent: Sent[] = [];
  const { mon, logs } = startMonitor('dispatch', {
    store: new SnapshotStore(),
    sent,
    report: async (n) => {
      if (n === 'forecast') return null;
      if (n !== 'curtailmentAlerts') return [];
      calls++;
      if (calls === 1) return [];
      // It opens at INFO (sets the family exemplar to info → Rule 4 silence), then
      // escalates to WARNING — the 09-23 peer-voldiff sequence.
      return [alert(churnId, calls === 2 ? 'info' : 'warning'), alert(chronicId, 'warning')];
    },
  });
  try {
    await until(() => sent.some((s) => s.title.includes(`Test ${churnId}`)), 5000, 'the escalated warning to be pushed');
    const push = sent.find((s) => s.title.includes(`Test ${churnId}`))!;
    assert.match(push.title, /\[Low\]/, 'demoted at warning tier, not silently dropped at info tier');
    assert.equal(push.severity, 'info');
    assert.ok(logs.some((l) => /notify: sent ".*Test churn-fam-COREXXX00XXX0002.*\(severity warning→info via auto-tune — Rule 4 \(high-volume churn\) on family "churn-fam": 201 rises, 0 short-clears \(0%\), 10 long-active \(5%\)\)/.test(l)),
      `the demotion names its rule and counts:\n${logs.filter((l) => l.includes('churn-fam')).join('\n')}`);
    await until(() => logs.some((l) => l.includes(`suppressed "Test ${chronicId}`)), 5000, 'the suppression line');
    const line = logs.find((l) => l.includes(`suppressed "Test ${chronicId}`))!;
    assert.match(line, /auto-tune Rule 3 \(chronic noise\) on family "chronic-fam" rated at warning: 21 rises, 0 short-clears \(0%\), 12 long-active \(57%\)/);
    assert.equal(sent.some((s) => s.title.includes(`Test ${chronicId}`)), false);
  } finally {
    await stopAndSettle(mon);
  }
});
