import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/snapshot.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollHealthVerdict, pollLogLines, POLL_SUMMARY_EVERY } from '../src/snapshot.js';
import { BASIS_MIN_BAND_COVERAGE } from '../src/nightChargeAdvisor.js';

/**
 * v1.148.0 — the second log audit's top findings.
 */
const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

// ── 3.3: a shadow must move a GATE, not only a diagnostic ────────────────────
/**
 * v1.142.0 taught the CONSUMERS to distrust a replayed payload and left every
 * GATE untouched. Measured across both live firings: `poll_health` stayed 'ok',
 * /api/health returned blind:false, and notePollOk ran on every shadowed poll so
 * the blind clock never aged. The sensor moved to 240; no verdict moved at all.
 */
const SHP2 = 'HD31ZAB1ZH8Z0018';

test('★ a REPLAYED payload makes the poll not-ok', () => {
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2], attemptedSns: [SHP2], failedSns: [], contentFrozenSns: [SHP2],
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'shp2-content-frozen');
  assert.deepEqual(v.ok === false && v.sns, [SHP2]);
});

test('★ harder evidence outranks it — a FAILED fetch names itself, not "frozen"', () => {
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2], attemptedSns: [SHP2], failedSns: [SHP2], contentFrozenSns: [SHP2],
  });
  assert.equal(v.ok === false && v.reason, 'shp2-fetch-failed');
});

test('a NOT-POLLED panel also outranks frozen', () => {
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2], attemptedSns: [], failedSns: [], contentFrozenSns: [SHP2],
  });
  assert.equal(v.ok === false && v.reason, 'shp2-not-polled');
});

test('a frozen NON-panel device does not make the poll not-ok', () => {
  // Only the alarm-path roster gates this; an accessory replaying is not our problem.
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2], attemptedSns: [SHP2], failedSns: [], contentFrozenSns: ['ACCESSORY'],
  });
  assert.equal(v.ok, true);
});

test('omitting contentFrozenSns entirely is backward-compatible', () => {
  assert.equal(pollHealthVerdict({ knownShp2Sns: [SHP2], attemptedSns: [SHP2], failedSns: [] }).ok, true);
});

test('★ BRIDGE: the live tick feeds the frozen set', () => {
  const s = src('snapshot.ts');
  const i = s.indexOf('pollHealthVerdict({');
  assert.ok(i > 0);
  const call = s.slice(i, s.indexOf('});', i));
  assert.match(call, /contentFrozenSns:/, 'the gate must actually receive the frozen set');
  assert.match(call, /contentStaleSinceMs != null/);
});

// ── 3.4: the latch must survive a restart, with a RE-STAMPED clock ───────────
test('★★ the witness SURVIVES a process restart — driven, not grepped', () => {
  // A source scan for the load/save methods passes even when nothing calls them,
  // which is exactly what the mutation harness caught on the first run.
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  const path = join(dir, 'shadow-witness.json');
  process.env.SHADOW_WITNESS_PATH = path;
  try {
    const raw = {
      'loadInfo.hall1Watt': [0, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
      'wattInfo.gridWatt': 7618,
    } as Record<string, unknown>;
    const item = { sn: 'SHP2-1', deviceName: 'SHP2-1', productName: 'Smart Home Panel 2', online: 1 } as never;

    // Process 1 — latch a shadow, which writes the witness.
    const a = new SnapshotStore();
    let t = 1_000_000;
    a.setClock(() => t);
    a.setDeviceList([item]);
    for (let i = 0; i < 16; i++) { a.setDeviceQuota('SHP2-1', raw); t += 60_000; }
    assert.ok(a.get().devices['SHP2-1'].contentStaleSinceMs != null, 'process 1 latched');
    assert.ok(existsSync(path), 'the witness was written to disk');

    // Process 2 — a fresh store, same payload still being replayed.
    const b = new SnapshotStore();
    let u = 9_000_000;
    b.setClock(() => u);
    b.setDeviceList([item]);
    b.setDeviceQuota('SHP2-1', raw);
    const f = (b as unknown as { contentFreshness: Map<string, { witness: string; firstSeenMs: number; repeats: number }> }).contentFreshness.get('SHP2-1');
    assert.ok(f, 'the witness rehydrated rather than starting cold');
    assert.equal(f!.firstSeenMs, u, '★ the clock is RE-STAMPED at rehydrate, never carried');
    assert.ok(f!.repeats <= 2, 'and the count restarts');
    assert.equal(
      b.get().devices['SHP2-1'].contentStaleSinceMs, null,
      'one matching poll after a restart must NOT latch stale instantly — that is a nuisance-alarm path',
    );
  } finally {
    delete process.env.SHADOW_WITNESS_PATH;
  }
});

test('★ the shadow witness is persisted', () => {
  // A fresh process published grid_power_home = 7618 W beside
  // shp2_payload_frozen = 0 — 7,618 being the exact value the PREVIOUS process
  // had already declared a stale shadow. ~60-90 s of a 7.6 kW ghost.
  const s = src('snapshot.ts');
  assert.match(s, /private loadContentFreshness\(nowMs: number\): void/);
  assert.match(s, /private saveContentFreshness\(\): void/);
});

test('★ …but firstSeenMs is RE-STAMPED at rehydrate, not carried', () => {
  // Carrying it would let the duration half of the AND be satisfied by history,
  // so one matching poll after a long gap latches stale immediately. That fails
  // safe but is a nuisance-alarm path: at the reserve floor it removes
  // backstopping and can escalate a benign grid-up low-SoC to critical.
  const s = src('snapshot.ts');
  const i = s.indexOf('private loadContentFreshness');
  const body = s.slice(i, s.indexOf('private saveContentFreshness', i));
  assert.match(body, /firstSeenMs: nowMs/, 'the clock restarts at rehydrate');
  assert.match(body, /repeats: 1/, 'and so does the count');
  assert.ok(!/firstSeenMs: v\./.test(body), 'the persisted clock must never be trusted');
});

test('only the witness STRING is persisted — never the clock or count', () => {
  const s = src('snapshot.ts');
  const i = s.indexOf('private saveContentFreshness');
  const body = s.slice(i, i + 500);
  assert.match(body, /\{ witness: f\.witness \}/);
  assert.ok(!/firstSeenMs: f\./.test(body));
});

// ── §4: emission count, not level ────────────────────────────────────────────
/**
 * The three-release hygiene campaign NET-INCREASED volume by 52% and cut reach to
 * x0.65. Demoting bought nothing: LOG_LEVEL=debug is standing, pino writes every
 * level to stdout, and the ring captures stdout. Level is not emission.
 */
test('★ a routine poll mid-window emits NOTHING', () => {
  assert.deepEqual(
    pollLogLines({ tookMs: 420, failedCount: 4, lastPollFailed: false, slowMs: 5000, pollDebug: true }),
    [], 'this line was 32.5% of all log bytes and 88.3% of INFO lines',
  );
});

test('★ the distribution still reaches the log, once per window', () => {
  const out = pollLogLines({
    tookMs: 420, failedCount: 4, lastPollFailed: false, slowMs: 5000, pollDebug: true,
    summaryDue: true, summaryCount: 30, summaryP50Ms: 528, summaryP95Ms: 770, summaryMaxMs: 2015,
  });
  assert.deepEqual(out, ['poll duration over last 30 poll(s): p50 528ms p95 770ms max 2015ms']);
});

test('the per-event incident lines are UNTOUCHED', () => {
  // `(recovered)` and `poll slow:` are what an operator greps; the summary must
  // not absorb them. Both obvious discriminators are traps — a blanket demote
  // silences `poll slow:`, and startsWith('poll ok in') also matches '(recovered)'.
  assert.deepEqual(
    pollLogLines({ tookMs: 400, failedCount: 4, lastPollFailed: true, slowMs: 5000, pollDebug: false }),
    ['poll ok in 400ms (recovered)'],
  );
  const both = pollLogLines({ tookMs: 9000, failedCount: 4, lastPollFailed: true, slowMs: 5000, pollDebug: false });
  assert.equal(both.length, 2);
  assert.ok(both[1].startsWith('poll slow:'));
});

test('the summary window is ~30 min at a 60 s cadence', () => {
  assert.equal(POLL_SUMMARY_EVERY, 30);
});

// ── 3.1: the night-charge block names itself ─────────────────────────────────
test('★ basisBlockedBy names the failing gate, not the conjunction', () => {
  // basisComplete:false is four conditions wearing one coat. On 2026-09-10 three
  // passed and band coverage missed by six points; the pool sat at its 16% floor
  // for 9 h 13 m and the reason appeared nowhere.
  const s = src('nightChargeAdvisor.ts');
  assert.match(s, /const basisBlockedBy: string \| null = basisComplete/);
  for (const clause of [
    /no PV forecast available/,
    /climatology-tier/,
    /scored calibration day\(s\), need/,
    /PV band coverage \$\{Math\.round\(bandCoverageFrac \* 100\)\}% < /,
  ]) assert.match(s, clause, `missing branch: ${clause}`);
});

test('★ the reason reaches the rationale the operator actually hears', () => {
  const s = src('nightChargeAdvisor.ts');
  assert.match(s, /const why = inputs\.basisBlockedBy \? ` \(\$\{inputs\.basisBlockedBy\}\)` : '';/);
  assert.match(s, /basis incomplete\$\{why\}/);
});

test('the coverage floor is a named constant, and unchanged at 0.78', () => {
  // Naming it must not move it — the write gate in nightChargeGate accepts
  // [0.78, 0.92] and hand-widening here would move that too.
  assert.equal(BASIS_MIN_BAND_COVERAGE, 0.78);
  assert.match(src('nightChargeAdvisor.ts'), /bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE/);
});

// ── batched ──────────────────────────────────────────────────────────────────
test('the UNMEASURED line points at a route that exists', () => {
  const s = src('index.ts');
  assert.match(s, /see \/api\/night-charge\/status → plan\.buyDebiasBasis/);
  assert.ok(!/see \/api\/night-charge buyDebiasBasis/.test(s), 'the bare path 404s');
});

test("/api/health resolves the panel through findShp2(), not a raw find()", () => {
  const s = src('index.ts');
  const i = s.indexOf('shp2ContentFrozenMs:');
  assert.match(s.slice(i, i + 300), /findShp2\(store\.get\(\)\.devices\)/);
});

test('the HA broker reconnect matches the sibling client', () => {
  // 30 s vs the broker's own ~10 s recovery: 19.9 s of the outage was this knob.
  assert.match(src('mqttDiscovery.ts'), /reconnectPeriod: 5_000,/);
});
