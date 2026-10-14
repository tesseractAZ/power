/**
 * v1.186.0 — two findings from the 2026-09-24 log review, driven through the REAL broadcast
 * monitor (startBroadcastMonitor) with Home Assistant mocked at the HTTP layer (undici
 * MockAgent), the Wyoming renderer injected, and a controllable clock.
 *
 * (1) DEGRADED AUDIBLE CHANNEL. The audible-unreachable alarm fires only at ZERO usable Music
 *     Assistant speakers. One of two was `unavailable` for ~27 h and nothing said so; every
 *     broadcast logged "2 MA + 1 SIP target(s) → ok" with the CONFIGURED count.
 *
 * (2) TEST / ANNOUNCEMENT STATE CONTAMINATION. Every caller of the broadcast pipeline wrote the
 *     same bookkeeping. A verified red TEST armed the same-level storm gate, so a real red inside
 *     the next ~2 min was refused with no retry; and the last broadcast of ANY kind (the 21:30
 *     night-charge consent notice, a test) became the next boot's restart baseline, so a genuine
 *     new yellow after a restart was filed as "matches pre-restart advisory".
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-bcint-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha,media_player.beta';
process.env.BROADCAST_SIP_TARGETS = '';
process.env.BROADCAST_ANNOUNCE_VOLUME = 'standing'; // no pre-announce volume_set round trip
process.env.BROADCAST_MIN_SEVERITY = 'warning';     // a yellow condition is spoken
process.env.BROADCAST_QUIET_HOURS = '';
process.env.BROADCAST_BILINGUAL = 'false';
process.env.BROADCAST_END_OF_MESSAGE = 'false';
process.env.BROADCAST_REPEAT = '1';
process.env.BROADCAST_LEAD_SILENCE_MS = '0';
process.env.BROADCAST_ANNOUNCE_RETRIES = '0';
process.env.BROADCAST_UNREACHABLE_CONFIRM = '3';

const B = await import('../src/broadcast.js');
const H = await import('../src/broadcastHealth.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;

/* ── clock: real time flows, `offset` jumps it (bootMs, the storm gate, warm-up, retries) ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer ── */
const speakers: Record<string, string | null> = {};
let reads: Record<string, number> = {};
let blipReads: Record<string, number> = {};
let announces: Array<{ entity_id: string[]; url: string }> = [];
// v1.187.22 — the full registry (GET /core/api/states) the target-drift resolver reads.
let haStates: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }> = [];
// v1.187.22 — per-entity reads held in flight (holdReads): the next `skip` answer at once, the
// `left` after them wait for release; `at` is when each held read was dispatched.
let held: { skip: number; left: number; at: number[]; parked: Array<() => void> } | null = null;
function holdReads(skip: number, n: number): { at: number[]; parked: Array<() => void>; release: () => void } {
  const h = { skip, left: n, at: [] as number[], parked: [] as Array<() => void> };
  held = h;
  return { at: h.at, parked: h.parked, release: () => { if (held === h) held = null; for (const go of h.parked.splice(0)) go(); } };
}
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/services', method: 'GET' })
  .reply(200, JSON.stringify([{ domain: 'music_assistant', services: { play_announcement: {} } }])).persist();
ha.intercept({ path: '/core/api/states', method: 'GET' })
  .reply(() => ({ statusCode: 200, data: JSON.stringify(haStates) })).persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply((opts) => {
    const id = decodeURIComponent(String(opts.path).slice('/core/api/states/'.length));
    reads[id] = (reads[id] ?? 0) + 1;
    // A blip: `unavailable` for exactly the first N reads, decided here so no poll can race it.
    const st = reads[id] <= (blipReads[id] ?? 0) ? 'unavailable' : speakers[id];
    const statusCode = st == null ? 404 : 200;
    const body = st == null ? '{"message":"Entity not found."}' : JSON.stringify({ state: st, attributes: {} });
    // v1.187.22 — a held read answers only on release() (a probe parked on a slow Home Assistant).
    // This callback runs once per request, as it is dispatched, so the count is exact.
    const h = held;
    if (h && h.skip > 0) h.skip--;
    else if (h && h.left > 0) {
      h.left--;
      h.at.push(Date.now());
      return { statusCode, data: () => new Promise<string>((res) => { h.parked.push(() => res(body)); }) };
    }
    return { statusCode, data: body };
  }).persist();
ha.intercept({ path: '/core/api/services/music_assistant/play_announcement', method: 'POST' })
  .reply((opts) => {
    announces.push(JSON.parse(String(opts.body)));
    offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
    return { statusCode: 200, data: '[]' };
  }).delay(80).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-bcint-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
let ttsFailing = false;
const renderTts = async () => (ttsFailing
  ? { ok: false as const, error: 'wyoming refused (test)' }
  : { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;

const CRIT: Alert = { id: 'dpu-err-CORE1', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter fault', detail: 'x', fault: 'err7' } as Alert;
const WARN: Alert = { id: 'pack-temp-warn-CORE1', severity: 'warning', category: 'Thermal', device: 'Core 1', title: 'Pack temperature high', detail: 'x' };
// Excluded from the condition count (its audible is the runway alarm) yet a CRITICAL, so the
// condition reads green while the all-clear SPEECH gate holds — a silent green adoption.
const RESERVE: Alert = { id: 'shp2-below-reserve-SHP2-P', severity: 'critical', category: 'SHP2', device: 'SHP2', title: 'At reserve', detail: 'x' };

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  stop: () => void;
}
const live: Rig[] = [];
function rig(opts: { probeMs?: number; targetDriftDelayMs?: number } = {}): Rig {
  process.env.BROADCAST_HEALTH_PROBE_MS = String(opts.probeMs ?? 3_600_000);
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-bcint-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    targetDriftDelayMs: opts.targetDriftDelayMs,
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    // v1.187.22 — retried: a clip the stopped monitor was still rendering can land in the cache
    // while it is being removed (ENOTEMPTY under parallel load).
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); },
  };
  live.push(r);
  return r;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(r: Rig | null, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${r ? r.logs.join('\n') : ''}`);
    await sleep(5);
  }
}
/** Let the first tick join the current level (ticks run every 10 ms). */
const joined = () => sleep(80);
const pastWarmup = () => { offset += 11 * MIN; };

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  speakers['media_player.alpha'] = 'idle';
  speakers['media_player.beta'] = 'idle';
  reads = {};
  blipReads = {};
  announces = [];
  haStates = [];
  held = null;
  alerts = [];
  ttsFailing = false;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(KLAXON, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/* ══ (2a) the storm gate: a test is heard, and arms nothing ══════════════════════════════ */

test('★★★ a real red within 2 min of a verified red TEST is spoken (the test does not arm the storm gate)', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  const t = await r.mon.test('red');
  assert.equal(t.ok, true, t.messages.join('; '));
  assert.equal(announces.length, 1);
  assert.ok(r.has('broadcast: TEST red → ok'), 'the test is marked as a test in the log');

  alerts = [CRIT];
  await until(r, () => announces.length === 2 || r.has('(storm gate)'), 'the real red');
  assert.equal(announces.length, 2, 'the real red was spoken');
  assert.ok(r.has('condition transition → red'));
  assert.ok(!r.has('(storm gate)'), 'a test must never silence a real alarm');

  await until(r, () => r.mon.status().lastBroadcastKind === 'condition', 'the real red to settle');
  const s = r.mon.status();
  assert.equal(s.lastBroadcastKind, 'condition');
  assert.equal(s.stormSuppressedCount, 0);
});

test('★★★ a real red that QUEUES behind a playing test is spoken once the test ends', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  const p = r.mon.test('red');
  await until(r, () => announces.length === 1, 'the test reaching the speakers');
  alerts = [CRIT]; // the tick adopts it and enqueues it behind the in-flight test
  await until(r, () => r.has('condition transition → red'), 'the transition during the test');
  assert.equal((await p).ok, true);
  await until(r, () => announces.length === 2 || r.has('(storm gate)'), 'the queued red');
  assert.equal(announces.length, 2);
  assert.ok(!r.has('(storm gate)'));
});

test('★★ a SoC-ladder announcement within 2 min of a red test is spoken', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  assert.equal((await r.mon.test('red')).ok, true);
  const a = await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null);
  assert.equal(a.ok, true, a.error);
  assert.equal(announces.length, 2);
});

test('the status keeps its shape: lastLevel/lastOutcome still describe the last broadcast, now with its kind', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  assert.equal((await r.mon.test('red')).ok, true);
  const s = r.mon.status();
  assert.equal(s.lastLevel, 'red');
  assert.equal(s.lastOutcome, 'success');
  assert.equal(s.lastBroadcastKind, 'test');
  const disk = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  assert.equal(disk.lastLevel, 'red', 'the persisted summary still names what played last');
  assert.equal(disk.lastBroadcastKind, 'test');
  assert.notEqual(disk.conditionLevel, 'red', 'but a test never becomes the condition record');
});

test('★★ the storm gate still works between CONDITION broadcasts (red, then a yellow inside 2 min)', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  alerts = [CRIT];
  await until(r, () => announces.length === 1, 'the condition red');
  await until(r, () => r.mon.status().lastBroadcastKind === 'condition', 'the red to settle');
  alerts = [WARN];
  await until(r, () => r.has('suppressed — last red condition broadcast played'), 'the de-escalation to be gated');
  assert.equal(announces.length, 1);
  // …and a dedicated announcement is still gated by a condition red, as before.
  const a = await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /same-or-lower level within gap/);
});

test('★★ a dedicated announcement does not arm the same-level gap: a real red right after a SoC red is spoken', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  assert.equal((await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null)).ok, true);
  alerts = [CRIT];
  await until(r, () => announces.length === 2 || r.has('(storm gate)'), 'the condition red');
  assert.equal(announces.length, 2, 'a DIFFERENT alarm (the condition excludes the ladder ids) must not be silenced');
  assert.ok(!r.has('(storm gate)'));
});

test('★ the night-charge consent notice does not swallow a real yellow that follows it', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  const n = await r.mon.announce('medium', 'Night charge notice. Buying about 37 kilowatt hours overnight.', null, { consentNotice: true });
  assert.equal(n.ok, true, n.error);
  alerts = [WARN];
  await until(r, () => announces.length === 2 || r.has('(storm gate)'), 'the condition yellow');
  assert.equal(announces.length, 2);
});

test('the identical-message gate still holds for dedicated announcements (tier flapping)', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  const msg = 'Warning. Backup pool at 20 percent.';
  assert.equal((await r.mon.announce('high', msg, null)).ok, true);
  const again = await r.mon.announce('high', msg, null);
  assert.equal(again.ok, false);
  assert.match(again.error ?? '', /identical message/);
  assert.equal(announces.length, 1);
});

/* ══ (2b) the retry machinery belongs to real alarms ══════════════════════════════════════ */

test('★★ a failed TEST takes no deferred-retry slot (a real alarm\'s pending retry is not superseded)', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  speakers['media_player.alpha'] = 'unavailable';
  speakers['media_player.beta'] = 'unavailable';
  alerts = [WARN];
  await until(r, () => r.has('deferred retry 1/3'), 'the real yellow to defer');
  const t = await r.mon.test('red');
  assert.equal(t.ok, false);
  assert.ok(r.has('TEST red not retried'), r.logs.join('\n'));
  assert.ok(!r.has('superseding the pending'), 'the yellow retry keeps its slot');
  assert.equal(r.logs.filter((l) => l.includes('deferred retry')).length, 1, 'no retry was armed for the test');
});

test('★★ a condition red whose speech failed keeps its spoken retry across a verified red TEST', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  ttsFailing = true;
  alerts = [CRIT];
  await until(r, () => r.has('one retry scheduled in 90s'), 'the chime-only fallback');
  ttsFailing = false;
  assert.equal((await r.mon.test('red')).ok, true);
  assert.ok(!r.has('pending spoken retry cancelled'), '"This is only a test" is not the condition\'s speech');
  offset += 91_000;
  await until(r, () => r.has('spoken retry after render failure → red'), 'the spoken retry');
});

test('★★ …and across a verified SoC-ladder red (a condition retry is satisfied by a condition delivery only)', async () => {
  const r = rig();
  await joined();
  pastWarmup();
  ttsFailing = true;
  alerts = [CRIT];
  await until(r, () => r.has('one retry scheduled in 90s'), 'the chime-only fallback');
  ttsFailing = false;
  assert.equal((await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null)).ok, true);
  assert.ok(!r.has('pending spoken retry cancelled'));
  offset += 91_000;
  await until(r, () => r.has('spoken retry after render failure → red'), 'the spoken retry');
});

/* ══ (2c) the restart baseline is the CONDITION, not the last broadcast ══════════════════ */

async function speakConditionYellow(r: Rig): Promise<void> {
  alerts = [WARN];
  await until(r, () => r.mon.status().conditionSpoken === true && r.mon.status().conditionLevel === 'yellow', 'a spoken condition yellow');
}
/** Boot a fresh monitor on the persisted state; the store looks empty on the first tick, then
 *  the warning appears inside the warm-up window. Resolves with what the monitor did. */
async function rebootAndRaiseYellow(): Promise<{ r: Rig; spoken: boolean }> {
  alerts = [];
  const r = rig();
  await joined();
  alerts = [WARN];
  await until(r, () => r.has('yellow held for boot confirmation') || r.has('matches pre-restart advisory'), 'the post-boot yellow');
  if (r.has('matches pre-restart advisory')) return { r, spoken: false };
  const before = announces.length;
  offset += 2 * MIN + 5_000; // BOOT_YELLOW_CONFIRM_MS
  await until(r, () => announces.length > before, 'the confirmed yellow');
  assert.ok(r.has('condition transition → yellow'));
  return { r, spoken: true };
}

test('★★★ a post-restart real yellow is NOT swallowed by a consent-notice baseline', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  const n = await a.mon.announce('medium', 'Night charge notice. Buying about 37 kilowatt hours overnight.', null, { consentNotice: true });
  assert.equal(n.ok, true);
  assert.equal(a.mon.status().lastLevel, 'yellow', 'the notice is the last broadcast');
  a.stop();

  const { r, spoken } = await rebootAndRaiseYellow();
  assert.equal(r.mon.status().bootBaselineLevel, null, 'the house was green: no yellow baseline');
  assert.equal(spoken, true, 'a genuine new yellow after the restart must be spoken');
});

test('★★★ …nor by a red TEST baseline', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  assert.equal((await a.mon.test('red')).ok, true);
  a.stop();
  const { spoken } = await rebootAndRaiseYellow();
  assert.equal(spoken, true);
});

test('★★ v0.58.0 kept: a condition yellow that WAS spoken is not re-spoken after a restart', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  await speakConditionYellow(a);
  a.stop();
  const { r, spoken } = await rebootAndRaiseYellow();
  assert.equal(r.mon.status().bootBaselineLevel, 'yellow');
  assert.equal(spoken, false, 'the restart continuation still suppresses the duplicate');
});

test('★★ a green adopted SILENTLY (all-clear speech gated) replaces the spoken yellow as the baseline', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  await speakConditionYellow(a);
  alerts = [RESERVE];
  // v1.187.0 — a green commits only after it has stood CONDITION_CLEAR_DWELL_MS.
  await until(a, () => a.has('yellow → green held'), 'the de-escalation dwell');
  offset += B.CONDITION_CLEAR_DWELL_MS + 1_000;
  await until(a, () => a.has('green adopted silently'), 'the silent green');
  assert.equal(a.mon.status().conditionLevel, 'green');
  a.stop();
  const { spoken } = await rebootAndRaiseYellow();
  assert.equal(spoken, true, 'the house was green before the restart — a new yellow is new');
});

test('★★ a yellow the household never HEARD (storm-gated) gives no baseline: it is spoken after a restart', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  alerts = [CRIT];
  await until(a, () => announces.length === 1 && a.mon.status().lastBroadcastKind === 'condition', 'the condition red');
  alerts = [WARN];
  await until(a, () => a.has('(storm gate)'), 'the yellow to be storm-gated');
  const s = a.mon.status();
  assert.equal(s.conditionLevel, 'yellow');
  assert.equal(s.conditionSpoken, false);
  a.stop();
  const { spoken } = await rebootAndRaiseYellow();
  assert.equal(spoken, true);
});

test('★★ a verified yellow TEST does not mark an unheard condition yellow as heard', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  alerts = [CRIT];
  await until(a, () => announces.length === 1 && a.mon.status().lastBroadcastKind === 'condition', 'the condition red');
  alerts = [WARN];
  await until(a, () => a.has('(storm gate)'), 'the yellow to be storm-gated');
  assert.equal((await a.mon.test('yellow')).ok, true);
  assert.equal(a.mon.status().conditionSpoken, false, 'the household heard a test, not the warning');
  a.stop();
  const { spoken } = await rebootAndRaiseYellow();
  assert.equal(spoken, true);
});

test('★★ a condition that cleared while the add-on was down stops being the baseline once the warm-up ends', async () => {
  const a = rig();
  await joined();
  pastWarmup();
  await speakConditionYellow(a);
  a.stop();

  alerts = []; // the warning cleared during the downtime
  const b = rig();
  await joined();
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  pastWarmup();
  await until(b, () => b.mon.status().conditionLevel === 'green', 'the post-warm-up reconciliation');
  assert.equal(b.mon.status().conditionSpoken, false);
  b.stop();

  const { spoken } = await rebootAndRaiseYellow();
  assert.equal(spoken, true, 'the next restart does not inherit the stale yellow');
});

/* ══ (1) the degraded audible channel ════════════════════════════════════════════════════ */

test('★★★ one of two speakers unavailable → a named DEGRADED alert after the debounce; cleared when it returns', async () => {
  speakers['media_player.beta'] = 'unavailable';
  const r = rig({ probeMs: 15 });
  await until(r, () => r.has('audible channel DEGRADED'), 'the degraded confirmation');
  assert.ok(r.has('not reachable: media_player.beta (unavailable)'));
  const h = H.getBroadcastHealth();
  assert.equal(h.reachable, true, 'one speaker still plays — not the unreachable alarm');
  assert.equal(h.degraded, true);
  const alert = H.broadcastDegradedAlert(h, realNow());
  assert.ok(alert);
  assert.match(alert!.detail, /Only 1 of 2 configured speaker\(s\)/);
  assert.match(alert!.detail, /media_player\.beta \(unavailable\)/);
  assert.equal(H.broadcastHealthAlert(h, realNow()), null);
  const s = r.mon.status();
  assert.equal(s.audibleDegraded, true);
  assert.deepEqual(s.audibleUnusableTargets, ['media_player.beta (unavailable)']);
  assert.equal(s.audibleConfiguredTargets, 2);

  speakers['media_player.beta'] = 'idle';
  await until(r, () => r.has('audible channel restored'), 'the recovery');
  assert.equal(H.getBroadcastHealth().degraded, false);
  assert.equal(H.broadcastDegradedAlert(H.getBroadcastHealth(), realNow()), null);
});

test('★★ a restart blip (two probes) never raises it', async () => {
  blipReads['media_player.beta'] = 2;
  const r = rig({ probeMs: 15 });
  await until(r, () => (reads['media_player.beta'] ?? 0) >= 8 && H.getBroadcastHealth().lastProbeAt != null, 'eight probes');
  assert.ok(!r.has('audible channel DEGRADED'), r.logs.join('\n'));
  assert.equal(H.getBroadcastHealth().degraded, false);
});

test('★★ a wall clock stepped back an hour: the probe keeps running and a confirmed degraded channel holds (no false "restored")', async () => {
  speakers['media_player.beta'] = 'unavailable';
  const r = rig({ probeMs: 15 });
  await until(r, () => r.has('audible channel DEGRADED'), 'the degraded confirmation');
  const before = reads['media_player.beta'] ?? 0;
  offset -= 3_600_000; // the clock steps back an hour (an NTP correction)
  try {
    // v0.84.0's throttle skipped every tick until the clock caught up: an hour without a probe.
    await until(r, () => (reads['media_player.beta'] ?? 0) >= before + 6, 'six probes after the step');
    // The step re-anchors the run's span (audibleRunStep); the confirmed state must not drop with it.
    assert.ok(!r.has('audible channel restored'), r.logs.join('\n'));
    assert.equal(H.getBroadcastHealth().degraded, true);
    assert.equal(r.logs.filter((l) => l.includes('audible channel DEGRADED')).length, 1, 'confirmed once, never re-confirmed');
    speakers['media_player.beta'] = 'idle';
    await until(r, () => r.has('audible channel restored'), 'the recovery');
    assert.equal(H.getBroadcastHealth().degraded, false);
  } finally {
    offset += 3_600_000;
  }
});

/** v1.187.22 — a failed broadcast (no usable speaker) forces a health probe. */
async function failedBroadcast(r: Rig, tag: string): Promise<void> {
  const res = await r.mon.announce('high', `Warning. Probe ${tag}.`, null);
  assert.equal(res.ok, false, `broadcast ${tag} found no usable speaker`);
  assert.match(res.error ?? '', /all broadcast targets unavailable/, `broadcast ${tag} reached the pre-flight that forces the probe`);
}
/** …and wait for that probe to publish; resolves to when the broadcast began. */
async function forcedProbe(r: Rig, tag: string): Promise<number> {
  const at = Date.now();
  await failedBroadcast(r, tag);
  await until(r, () => (H.getBroadcastHealth().lastProbeAt ?? 0) >= at, `the probe forced by broadcast ${tag}`);
  return at;
}

test('★★★ forced probes in a restart window never confirm the channel dead (2026-10-12 22:04)', async () => {
  // Music Assistant restarting after a host reboot: its players are gone from Home Assistant.
  speakers['media_player.alpha'] = null;
  speakers['media_player.beta'] = null;
  const r = rig({ probeMs: MIN }); // the production period: only the forced probes below run
  await joined();
  pastWarmup();
  const base = offset;
  // 22:04:13 a failed broadcast, 22:04:24 the boot kick, 22:04:44 the failed retry — then the
  // next periodic probe at +71 s. Each one reads zero usable speakers.
  for (const [tag, at] of [['one', 0], ['two', 11_000], ['three', 31_000], ['four', 71_000]] as const) {
    offset = base + at;
    await forcedProbe(r, tag);
    const h = H.getBroadcastHealth();
    assert.equal(h.reachable, null, `+${at / 1000} s: three probes in 31 s are a restart window, not a dead channel`);
    assert.equal(h.degraded, false, `+${at / 1000} s: nor a degraded one`);
    assert.equal(H.broadcastHealthAlert(h, realNow()), null);
    assert.equal(H.broadcastDegradedAlert(h, realNow()), null);
  }
  assert.ok(!r.has('audible channel DEGRADED'), r.logs.join('\n'));
  // A real outage: the run that began with the first forced probe is confirmed at the span.
  offset = base + 2 * MIN;
  await forcedProbe(r, 'five');
  const h = H.getBroadcastHealth();
  assert.equal(h.reachable, false, 'confirmed two probe periods after the first failing probe');
  assert.ok(H.broadcastHealthAlert(h, realNow()));
  assert.ok(r.has('audible channel DEGRADED'));
  assert.equal(r.mon.status().audibleReachable, false);
});

/**
 * v1.187.22 — every probe the monitor publishes from now on, sampled every 2 ms (these probes run
 * ≥ 25 ms apart); `sample()` takes the current one at once, before a test reads `seen`.
 */
interface Seen { at: number; usable: number; reachable: boolean | null; degraded: boolean }
function watchProbes(): { seen: Seen[]; sample: () => Seen[]; stop: () => void } {
  const seen: Seen[] = [];
  const from = Date.now();
  const sample = (): Seen[] => {
    const h = H.getBroadcastHealth();
    if (h.lastProbeAt != null && h.lastProbeAt >= from && h.lastProbeAt !== seen[seen.length - 1]?.at) {
      seen.push({ at: h.lastProbeAt, usable: h.usableTargets, reachable: h.reachable, degraded: h.degraded === true });
    }
    return seen;
  };
  const t = setInterval(sample, 2);
  return { seen, sample, stop: () => clearInterval(t) };
}
/** Sleep until the test clock (Date.now, offset included) reaches `at`. */
async function sleepUntil(at: number): Promise<void> {
  const d = at - Date.now();
  if (d > 0) await sleep(d);
}
// A real-time probe period: the next tests run the monitor's own interval and timers. Every probe
// they place is placed from the run's FIRST failing probe (or the tick before it), never from a
// tick expected at a later beat, and every bound is a fraction of P, not a few milliseconds: on a
// loaded machine a broadcast's pre-flight takes hundreds of ms and a timer fires late by as much,
// so P is 2 s. A late confirmation lands on the tick past the span — 3P after the run's first
// probe in the first and third tests, over 2.5P in the second (its run opens under 0.5P after a
// tick); LATE sits under all of them, 0.5P past the span.
const P = 2000;
const LATE = 2.5 * P;

test('★★★ a forced probe short of the span does not push confirmation to a later tick', async () => {
  speakers['media_player.alpha'] = null;
  speakers['media_player.beta'] = null;
  const w = watchProbes();
  try {
    const r = rig({ probeMs: P });
    await joined();
    pastWarmup();
    await until(r, () => w.seen.length >= 2, 'two periodic probes', 4 * P);
    const since = w.seen[0].at;
    assert.equal(w.seen[0].usable, 0);
    assert.equal(w.seen[1].reachable, null, 'two periodic probes: pending');
    // A failed alarm broadcast forces a probe short of the span: the count is met, the span is
    // not, and the forced probe restarts the throttle, so the tick AT the span is skipped. The
    // probe armed at the span confirms, not the tick a period later.
    await sleepUntil(since + 1.3 * P);
    const forcedAt = await forcedProbe(r, 'short of the span');
    await until(r, () => H.getBroadcastHealth().reachable === false, 'the confirmation', 4 * P);
    const seen = w.sample();
    const trace = JSON.stringify(seen.map((x) => [x.at - since, x.usable, x.reachable]));
    const forced = seen.find((x) => x.at >= forcedAt)!;
    assert.ok(forced.at - since < 1.9 * P, `precondition: the forced probe ran short of the span: ${trace}`);
    assert.ok(seen.indexOf(forced) >= 2, `precondition: the count is met there (two periodic probes before it): ${trace}`);
    assert.equal(forced.reachable, null, 'three failing probes, span not met: not confirmed');
    assert.equal(forced.degraded, false);
    const c = seen.find((x) => x.reachable === false)!;
    const took = c.at - since;
    assert.ok(took >= 2 * P, `not before the span: ${trace}`);
    assert.ok(took < LATE, `confirmed at the span (${2 * P} ms), not at a later tick: ${trace}`);
    assert.equal(c.degraded, true, 'the degraded run is confirmed at the same span');
  } finally {
    w.stop();
  }
});

test('★★★ a run opened by a forced probe between ticks is confirmed at its span, not at the next tick past it', async () => {
  const w = watchProbes();
  try {
    const r = rig({ probeMs: P });
    await joined();
    pastWarmup();
    await until(r, () => w.seen.length >= 1, 'the first periodic probe', 4 * P);
    assert.equal(w.seen[0].reachable, true);
    // Music Assistant goes down just after that tick, and a failed alarm broadcast sees it first.
    await sleepUntil(w.seen[0].at + 0.2 * P);
    speakers['media_player.alpha'] = null;
    speakers['media_player.beta'] = null;
    await forcedProbe(r, 'opens the run');
    await until(r, () => H.getBroadcastHealth().reachable === false, 'the confirmation', 5 * P);
    const seen = w.sample();
    const since = seen.find((x) => x.usable === 0)!.at;
    const trace = JSON.stringify(seen.map((x) => [x.at - since, x.usable, x.reachable]));
    assert.ok(since - seen[0].at < 0.5 * P, `precondition: the forced probe opened the run between two ticks: ${trace}`);
    const c = seen.find((x) => x.reachable === false)!;
    const took = c.at - since;
    assert.ok(took >= 2 * P, `not before the span: ${trace}`);
    assert.ok(took < LATE, `confirmed at the span (${2 * P} ms), not at the next tick past it: ${trace}`);
    assert.equal(c.degraded, true);
    assert.ok(seen.filter((x) => x.at >= since && x.at < c.at).every((x) => x.reachable === true), `held true until then: ${trace}`);
  } finally {
    w.stop();
  }
});

test('★★ a probe armed at the span that runs into a probe still in flight is re-armed by it: confirmed as that one lands', async () => {
  speakers['media_player.alpha'] = null;
  speakers['media_player.beta'] = null;
  const w = watchProbes();
  let h: ReturnType<typeof holdReads> | null = null;
  try {
    const r = rig({ probeMs: P });
    await joined();
    pastWarmup();
    await until(r, () => w.seen.length >= 2, 'two periodic probes', 4 * P);
    const since = w.seen[0].at;
    assert.equal(w.seen[1].reachable, null, 'two periodic probes: pending');
    // A failed alarm broadcast short of the span: its own pre-flight reads answer, the probe it
    // forces is parked on its two state reads (a slow Home Assistant) past the span, so the probe
    // armed AT the span runs into it and is dropped by the re-entrancy guard.
    await sleepUntil(since + 1.3 * P);
    h = holdReads(2, 2);
    const readsBefore = Object.values(reads).reduce((a, b) => a + b, 0);
    await failedBroadcast(r, 'held in flight');
    await until(r, () => h!.parked.length === 2, 'the forced probe parked on its reads', 2 * P);
    const forcedAt = h.at[0];
    await sleepUntil(since + 2.3 * P);
    const readsHeld = Object.values(reads).reduce((a, b) => a + b, 0) - readsBefore;
    const releasedAt = Date.now();
    h.release();
    await until(r, () => H.getBroadcastHealth().reachable === false, 'the confirmation', 4 * P);
    const c = H.getBroadcastHealth().lastProbeAt!;
    const trace = JSON.stringify({ seen: w.sample().map((x) => [x.at - since, x.usable, x.reachable]), forced: forcedAt - since, released: releasedAt - since, confirmed: c - since });
    assert.ok(forcedAt - since < 1.9 * P, `precondition: the forced probe began short of the span: ${trace}`);
    assert.ok(releasedAt - since >= 2.2 * P, `precondition: still in flight well past the probe armed at the span: ${trace}`);
    assert.equal(readsHeld, 4, `precondition: no other probe read while it was in flight (the pre-flight's two, its two): ${trace}`);
    assert.ok(c >= releasedAt, `the in-flight probe (begun short of the span) did not confirm: ${trace}`);
    assert.ok(c - releasedAt < 0.4 * P, `re-armed by the probe it ran into: confirmed as that one lands, not a period later: ${trace}`);
    assert.equal(H.getBroadcastHealth().degraded, true);
  } finally {
    h?.release();
    w.stop();
  }
});

test('★★ no speakers configured: unreachable on the FIRST probe, never debounced', async () => {
  const saved = process.env.BROADCAST_TARGETS;
  process.env.BROADCAST_TARGETS = '';
  const w = watchProbes();
  try {
    const r = rig({ probeMs: 150 });
    await until(r, () => w.seen.length >= 2, 'two probes', 3000);
    assert.equal(w.sample()[0].reachable, false, 'the first probe reports it');
    const h = H.getBroadcastHealth();
    assert.equal(h.reachable, false);
    assert.equal(h.reason, 'no speakers configured (BROADCAST_TARGETS empty)');
    assert.ok(H.broadcastHealthAlert(h, realNow()));
    assert.equal(r.mon.status().audibleReachable, false);
  } finally {
    w.stop();
    process.env.BROADCAST_TARGETS = saved;
  }
});

test('★★ a renamed speaker id is unreachable at once and stays so through the failing probes inside the span', async () => {
  speakers['media_player.alpha'] = null;
  speakers['media_player.beta'] = null;
  // Other media_players exist, the configured ids do not: the rename signature.
  haStates = [
    { entity_id: 'media_player.alpha_2', state: 'idle', attributes: {} },
    { entity_id: 'media_player.beta_2', state: 'idle', attributes: {} },
  ];
  const r = rig({ probeMs: MIN, targetDriftDelayMs: 200 });
  pastWarmup(); // before the resolver runs, so its run starts on the clock the probes below read
  await joined();
  await until(r, () => r.has('NOT FOUND in Home Assistant'), 'the target-drift resolver');
  const s = r.mon.status();
  assert.equal(s.audibleReachable, false, 'surfaced at once: a rename never self-heals');
  assert.match(s.audibleReason ?? '', /renamed\/mistyped/);
  assert.equal(H.getBroadcastHealth().lastProbeAt, null, 'before any probe ran');
  const base = offset;
  for (const [tag, at] of [['one', 0], ['two', 11_000], ['three', 31_000]] as const) {
    offset = base + at;
    await forcedProbe(r, tag);
    const h = H.getBroadcastHealth();
    assert.equal(h.reachable, false, `+${at / 1000} s: a failing probe inside the span keeps it unreachable`);
    assert.ok(H.broadcastHealthAlert(h, realNow()));
  }
});

test('★★ a broadcast logs the USABLE count and names the speaker it will not reach', async () => {
  speakers['media_player.beta'] = 'unavailable';
  const r = rig();
  await joined();
  pastWarmup();
  assert.equal((await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null)).ok, true);
  const ok = r.logs.find((l) => l.includes('→ ok in'));
  assert.ok(ok, r.logs.join('\n'));
  assert.match(ok!, /\(1\/2 MA usable \(not reached: media_player\.beta \(unavailable\)\)/);
  assert.ok(!/\(2 MA/.test(ok!), 'never the configured count as if both played');
  assert.ok(r.has('only 1 of 2 Music Assistant target(s) usable; will not reach media_player.beta (unavailable)'));
});

/* ── pure pieces ─────────────────────────────────────────────────────────────────────────── */

test('conditionBootBaseline — only a HEARD condition level is a baseline; a pre-v1.186.0 record gives none', () => {
  assert.equal(B.conditionBootBaseline({ conditionLevel: 'yellow', conditionSpoken: true }), 'yellow');
  assert.equal(B.conditionBootBaseline({ conditionLevel: 'red', conditionSpoken: true }), 'red');
  assert.equal(B.conditionBootBaseline({ conditionLevel: 'yellow', conditionSpoken: false }), null);
  assert.equal(B.conditionBootBaseline({ conditionLevel: 'green', conditionSpoken: false }), null);
  // The live file today: the consent notice's yellow, no condition fields.
  assert.equal(B.conditionBootBaseline({ lastLevel: 'yellow', lastOutcome: 'success' } as any), null);
  assert.equal(B.conditionBootBaseline({ conditionLevel: 'amber', conditionSpoken: true }), null);
  assert.equal(B.conditionBootBaseline(null), null);
});

test('classifyAudibleTargets — usable is the old rule; a failed read is NOT usable (absence is not evidence)', () => {
  const c = B.classifyAudibleTargets(
    ['media_player.a', 'media_player.b', 'media_player.c'],
    [{ state: 'idle' }, { state: 'unavailable' }, null],
  );
  assert.deepEqual(c.usable, ['media_player.a']);
  assert.deepEqual(c.unusable, ['media_player.b (unavailable)', 'media_player.c (not found or unreadable)']);
});

test('audibleDegradedStep — confirmed on the 3rd periodic probe, cleared by one full probe, zero-usable counts', () => {
  const T = 5_000_000;
  let s: { streak: number; sinceMs: number | null; degraded: boolean } = { streak: 0, sinceMs: null, degraded: false };
  s = B.audibleDegradedStep(s, s.degraded, 2, 1, T, 3, MIN); assert.deepEqual(s, { streak: 1, sinceMs: T, degraded: false });
  s = B.audibleDegradedStep(s, s.degraded, 2, 1, T + MIN, 3, MIN); assert.deepEqual(s, { streak: 2, sinceMs: T, degraded: false });
  s = B.audibleDegradedStep(s, s.degraded, 2, 0, T + 2 * MIN, 3, MIN); assert.deepEqual(s, { streak: 3, sinceMs: T, degraded: true });
  s = B.audibleDegradedStep(s, s.degraded, 2, 1, T + 3 * MIN, 3, MIN); assert.equal(s.degraded, true);
  s = B.audibleDegradedStep(s, s.degraded, 2, 2, T + 4 * MIN, 3, MIN); assert.deepEqual(s, { streak: 0, sinceMs: null, degraded: false });
  assert.deepEqual(B.audibleDegradedStep({ streak: 0, sinceMs: null }, false, 0, 0, T, 1, MIN), { streak: 0, sinceMs: null, degraded: false },
    'no targets is the unreachable alarm\'s case');
  assert.deepEqual(B.audibleDegradedStep({ streak: 0, sinceMs: null }, false, 2, 1, T, 3, MIN), { streak: 1, sinceMs: T, degraded: false },
    'a fresh run is never degraded on its first probe');
});

/* ── v1.187.22 — the audible debounce spans time, not just probes ─────────────────────────── */

type Run = { streak: number; sinceMs: number | null };
/** One probe through both steps, as computeAudibleHealth runs them (2 speakers, CONFIRM 3, 60 s). */
function probeBoth(
  st: { reach: Run & { reachable: boolean | null }; deg: Run & { degraded: boolean } },
  atMs: number, usable: number, confirm = 3,
) {
  return {
    reach: B.audibleReachableStep(st.reach, st.reach.reachable, usable, atMs, confirm, MIN),
    deg: B.audibleDegradedStep(st.deg, st.deg.degraded, 2, usable, atMs, confirm, MIN),
  };
}
const bootState = () => ({
  reach: { streak: 0, sinceMs: null, reachable: null } as Run & { reachable: boolean | null },
  deg: { streak: 0, sinceMs: null, degraded: false } as Run & { degraded: boolean },
});
const S = 1_000;

test('★★★ the 2026-10-12 restart replay: forced 0 s, kick 11 s, forced 31 s, interval 71 s, usable 115 s — never confirmed', () => {
  const T0 = 9_000_000; // 22:04:13
  let st = bootState();
  for (const at of [0, 11 * S, 31 * S, 71 * S]) {
    st = probeBoth(st, T0 + at, 0);
    assert.equal(st.reach.reachable, null, `+${at / S} s: a restart window is not a dead channel (null never alarms)`);
    assert.equal(st.deg.degraded, false, `+${at / S} s: nor a degraded one`);
  }
  assert.equal(st.reach.streak, 4, 'every forced probe still counts');
  assert.equal(st.reach.sinceMs, T0, 'and none restarts the run\'s clock');
  st = probeBoth(st, T0 + 115 * S, 2);
  assert.deepEqual(st.reach, { streak: 0, sinceMs: null, reachable: true }, 'a usable read clears at once');
  assert.deepEqual(st.deg, { streak: 0, sinceMs: null, degraded: false });
});

test('★★★ a real outage probed at 0/60/120 s is confirmed at 120 s — not before, not later', () => {
  const T0 = 9_000_000;
  let st = bootState();
  st = probeBoth(st, T0, 0);
  st = probeBoth(st, T0 + MIN, 0);
  assert.equal(st.reach.reachable, null);
  assert.equal(st.deg.degraded, false);
  st = probeBoth(st, T0 + 2 * MIN, 0);
  assert.equal(st.reach.reachable, false, 'unreachable confirmed on the third periodic probe');
  assert.equal(st.deg.degraded, true, 'degraded confirmed with it');
  st = probeBoth(st, T0 + 3 * MIN, 0);
  assert.equal(st.reach.reachable, false, 'a confirmed run stays confirmed');
  assert.equal(st.deg.degraded, true);
});

// The step's half of the rule; the monitor's half (a probe armed AT the span, whatever the
// throttle skipped) is driven through the real interval in the tests above.
test('★★★ forced probes inside a real outage neither accelerate confirmation nor restart its clock', () => {
  const T0 = 9_000_000;
  let st = bootState();
  // The streak reaches 3 at +10 s; the span is not met until +120 s.
  for (const at of [0, 5 * S, 10 * S, 20 * S, MIN, 90 * S, 2 * MIN - 1]) {
    st = probeBoth(st, T0 + at, 0);
    assert.equal(st.reach.reachable, null, `+${at} ms: not confirmed before the span`);
    assert.equal(st.deg.degraded, false, `+${at} ms: not degraded before the span`);
  }
  st = probeBoth(st, T0 + 2 * MIN, 0);
  assert.equal(st.reach.reachable, false, 'confirmed on the first probe at the span: the forced probes did not restart the clock');
  assert.equal(st.deg.degraded, true);
});

test('★★ the span is measured from the first failing probe of the CURRENT run: a usable read restarts it', () => {
  const T0 = 9_000_000;
  let st = bootState();
  st = probeBoth(st, T0, 0);
  st = probeBoth(st, T0 + 30 * S, 2);
  assert.equal(st.reach.reachable, true);
  // A new run 200 s after the first failing probe ever seen: three probes in 100 s.
  st = probeBoth(st, T0 + 200 * S, 0);
  st = probeBoth(st, T0 + 260 * S, 0);
  st = probeBoth(st, T0 + 300 * S, 0);
  assert.equal(st.reach.reachable, true, 'the pending run holds the prior published value (true), not null, not false');
  assert.equal(st.deg.degraded, false);
  st = probeBoth(st, T0 + 320 * S, 0);
  assert.equal(st.reach.reachable, false, 'confirmed 120 s after the run began');
  assert.equal(st.deg.degraded, true);
});

test('★★ CONFIRM = 1 stays immediate: the first failing probe confirms', () => {
  let st = probeBoth(bootState(), 9_000_000, 0, 1);
  assert.equal(st.reach.reachable, false);
  assert.equal(st.deg.degraded, true);
  st = probeBoth(st, 9_000_000 + S, 2, 1);
  assert.equal(st.reach.reachable, true);
  assert.equal(st.deg.degraded, false);
  assert.equal(B.audibleRunStep({ streak: 0, sinceMs: null }, true, 9_000_000, 1, MIN).confirmed, true);
});

test('★★ partial channel: one usable speaker clears the unreachable run at once, the degraded run carries on', () => {
  const T0 = 9_000_000;
  let st = bootState();
  st = probeBoth(st, T0, 0);
  st = probeBoth(st, T0 + MIN, 1);
  assert.deepEqual(st.reach, { streak: 0, sinceMs: null, reachable: true });
  assert.deepEqual(st.deg, { streak: 2, sinceMs: T0, degraded: false });
  st = probeBoth(st, T0 + 2 * MIN, 1);
  assert.equal(st.deg.degraded, true, 'degraded confirmed on the run that began at zero usable');
  assert.equal(st.reach.reachable, true);
});

test('★★★ audibleProbeDeadline — a pending run is probed AT its span, measured from its first failing probe', () => {
  const T = 9_000_000;
  const none: Run = { streak: 0, sinceMs: null };
  const run = (sinceMs: number, streak = 1): Run => ({ streak, sinceMs });
  assert.equal(B.audibleProbeDeadline(none, null, none, false, T, 3, MIN), null, 'nothing open');
  assert.equal(B.audibleProbeDeadline(run(T), null, run(T), false, T + 50 * S, 3, MIN), T + 2 * MIN,
    'from the first failing probe, not the latest');
  assert.equal(B.audibleProbeDeadline(run(T), true, none, false, T + 90 * S, 3, MIN), T + 2 * MIN,
    'a held `true` is still pending');
  assert.equal(B.audibleProbeDeadline(none, true, run(T), false, T + S, 3, MIN), T + 2 * MIN,
    'a degraded run alone is probed at its span');
  assert.equal(B.audibleProbeDeadline(run(T + 30 * S), true, run(T - 5 * MIN, 6), true, T + 40 * S, 3, MIN), T + 30 * S + 2 * MIN,
    'an unreachable run alone (the degraded one already confirmed) is probed at its span');
  assert.equal(B.audibleProbeDeadline(run(T + 10 * S), null, run(T), false, T + 20 * S, 3, MIN), T + 2 * MIN, 'both open: the earlier');
  assert.equal(B.audibleProbeDeadline(run(T, 3), false, run(T, 3), true, T + 2 * MIN, 3, MIN), null, 'both confirmed');
  assert.equal(B.audibleProbeDeadline(run(T, 3), false, none, false, T + S, 3, MIN), null,
    'reachable already false (a rename, no speakers): nothing to confirm');
  assert.equal(B.audibleProbeDeadline(run(T, 2), null, none, false, T + 2 * MIN, 3, MIN), null,
    'a run at its span with a short count is left to the periodic probe');
  assert.equal(B.audibleProbeDeadline(run(T, 2), null, run(T, 2), false, T + 3 * MIN, 3, MIN), null,
    'and one past it is not probed again at once (no probe storm)');
  assert.equal(B.audibleProbeDeadline(run(T), null, run(T), false, T, 1, MIN), null, 'CONFIRM = 1: nothing to wait for');
});

test('★★ a wall clock stepped back past the run\'s first probe re-anchors the span: the hold stays bounded', () => {
  const T0 = 9_000_000_000;
  let st = bootState();
  st = probeBoth(st, T0, 0);
  st = probeBoth(st, T0 + MIN, 0);
  const back = T0 + 90 * S - 3_600_000; // the clock steps back an hour
  st = probeBoth(st, back, 0);
  assert.equal(st.reach.sinceMs, back, 're-anchored at the step');
  assert.equal(st.deg.sinceMs, back);
  assert.equal(st.reach.reachable, null);
  assert.equal(B.audibleProbeDeadline(st.reach, st.reach.reachable, st.deg, st.deg.degraded, back, 3, MIN), back + 2 * MIN,
    'the probe is armed one span away, not an hour and a span');
  st = probeBoth(st, back + 2 * MIN, 0);
  assert.equal(st.reach.reachable, false, 'confirmed one span after the step');
  assert.equal(st.deg.degraded, true);
});

test('★★★ a confirmed degraded channel HOLDS through a wall clock stepped back: no false "restored", no second push', () => {
  const T0 = 9_000_000_000;
  let st = bootState();
  // One of two speakers dark: degraded confirmed at the span; the unreachable run never opens.
  st = probeBoth(st, T0, 1);
  st = probeBoth(st, T0 + MIN, 1);
  st = probeBoth(st, T0 + 2 * MIN, 1);
  assert.equal(st.deg.degraded, true, 'confirmed at the span');
  const back = T0 + 3 * MIN - 3_600_000; // the clock steps back an hour
  st = probeBoth(st, back, 1);
  assert.equal(st.deg.sinceMs, back, 'the run re-anchors at the step (audibleRunStep)');
  assert.equal(st.deg.degraded, true, 'but a failing probe never clears a confirmed degraded channel');
  assert.equal(B.audibleProbeDeadline(st.reach, st.reach.reachable, st.deg, st.deg.degraded, back, 3, MIN), null,
    'nothing left to confirm: no probe armed');
  st = probeBoth(st, back + MIN, 0);
  assert.equal(st.deg.degraded, true, 'nor does the last speaker going dark');
  assert.equal(st.reach.reachable, true, 'which is the unreachable run\'s own debounce (it held the prior true)');
  st = probeBoth(st, back + 2 * MIN, 2);
  assert.deepEqual(st.deg, { streak: 0, sinceMs: null, degraded: false }, 'only a read with every speaker usable clears it');
  // The unreachable state already held the same way (audibleReachableStep keeps the prior false).
  let u = { streak: 0, sinceMs: null as number | null, reachable: null as boolean | null };
  for (const at of [T0, T0 + MIN, T0 + 2 * MIN]) u = B.audibleReachableStep(u, u.reachable, 0, at, 3, MIN);
  assert.equal(u.reachable, false);
  u = B.audibleReachableStep(u, u.reachable, 0, T0 + 3 * MIN - 3_600_000, 3, MIN);
  assert.equal(u.reachable, false, 'unreachable holds through the step too');
});

test('★★★ audibleProbeDue — a tick read just short of the period still probes (interval jitter); a forced probe still defers it', () => {
  const T = 9_000_000;
  assert.equal(B.audibleProbeDue(T, 0, MIN), true, 'the first probe');
  assert.equal(B.audibleProbeDue(T + MIN, T, MIN), true, 'a full period');
  assert.equal(B.audibleProbeDue(T + MIN - 1, T, MIN), true,
    'the next tick read 1 ms short (Date.now against the interval\'s loop clock): v0.84.0 skipped it');
  assert.equal(B.audibleProbeDue(T + MIN - 30, T, MIN), true, 'the last tick stalled 30 ms before it read the clock');
  assert.equal(B.audibleProbeDue(T + MIN - B.AUDIBLE_PROBE_JITTER_MAX_MS, T, MIN), true, 'the tolerance: 1 s at the 60 s period');
  assert.equal(B.audibleProbeDue(T + MIN - B.AUDIBLE_PROBE_JITTER_MAX_MS - 1, T, MIN), false, 'past it the throttle holds');
  assert.equal(B.audibleProbeDue(T + 30 * S, T, MIN), false, 'a forced probe half a period ago defers the tick');
  assert.equal(B.audibleProbeDue(T + 1, T, MIN), false, 'and one just before it');
  // A short period: P/10.
  assert.equal(B.audibleProbeDue(T + 999, T, 1000), true, 'P − 1 at a 1 s period');
  assert.equal(B.audibleProbeDue(T + 900, T, 1000), true);
  assert.equal(B.audibleProbeDue(T + 899, T, 1000), false, 'P/10 at most: a probe never runs within 0.9 P of another');
  assert.equal(B.audibleProbeDue(T - 3_600_000, T, MIN), true,
    'a wall clock stepped back past the last probe is due at once, not an hour later');
  assert.equal(B.audibleProbeDue(T + MIN - 80, T, MIN), true,
    'a stall past the deadline\'s 25 ms slack (a GC pause on a loaded host) is still covered');
});

const HB = (over: Partial<import('../src/broadcastHealth.js').BroadcastHealth>) => ({
  enabled: true, supervised: true, targetCount: 2, usableTargets: 1, musicAssistantAvailable: true,
  reachable: true, reason: null, lastProbeAt: 1, degraded: true, unusableTargets: ['media_player.b (unavailable)'], ...over,
});

test('broadcastDegradedAlert — a WARNING push naming the missing speaker; yields to the unreachable alarm', () => {
  const a = H.broadcastDegradedAlert(HB({}), 0);
  assert.ok(a);
  assert.equal(a!.id, H.AUDIBLE_DEGRADED_ALERT_ID);
  assert.equal(a!.severity, 'warning');
  assert.equal(a!.priority, 'medium');
  assert.notEqual(a!.annunciate, false, 'it must push');
  assert.match(a!.detail, /media_player\.b \(unavailable\)/);
  // One alert, not two, once the channel is confirmed dead.
  const dead = HB({ reachable: false, usableTargets: 0 });
  assert.equal(H.broadcastDegradedAlert(dead, 0), null);
  assert.ok(H.broadcastHealthAlert(dead, 0));
  assert.equal(H.broadcastDegradedAlert(HB({ degraded: false }), 0), null);
  assert.equal(H.broadcastDegradedAlert(HB({ degraded: undefined }), 0), null);
  assert.equal(H.broadcastDegradedAlert(HB({ enabled: false }), 0), null);
  assert.equal(H.broadcastDegradedAlert(HB({ supervised: false }), 0), null);
});

test('the degraded alert never raises the audible condition (no chime over a half-dead channel)', () => {
  const a = H.broadcastDegradedAlert(HB({}), 0)!;
  assert.equal(B.conditionFromAlerts([a]).level, 'green');
});

test('the alert engine publishes it next to the unreachable alert', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/alertMonitor.ts'), 'utf8');
  assert.ok(src.includes('...(() => { const a = broadcastDegradedAlert(getBroadcastHealth(), Date.now()); return a ? [a] : []; })(),'));
});
