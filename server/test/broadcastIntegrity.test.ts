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
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/services', method: 'GET' })
  .reply(200, JSON.stringify([{ domain: 'music_assistant', services: { play_announcement: {} } }])).persist();
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply((opts) => {
    const id = decodeURIComponent(String(opts.path).slice('/core/api/states/'.length));
    reads[id] = (reads[id] ?? 0) + 1;
    // A blip: `unavailable` for exactly the first N reads, decided here so no poll can race it.
    const st = reads[id] <= (blipReads[id] ?? 0) ? 'unavailable' : speakers[id];
    if (st == null) return { statusCode: 404, data: '{"message":"Entity not found."}' };
    return { statusCode: 200, data: JSON.stringify({ state: st, attributes: {} }) };
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
function rig(opts: { probeMs?: number } = {}): Rig {
  process.env.BROADCAST_HEALTH_PROBE_MS = String(opts.probeMs ?? 3_600_000);
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-bcint-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); },
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
  alerts = [];
  ttsFailing = false;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
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

test('audibleDegradedStep — confirmed on the 3rd short probe, cleared by one full probe, zero-usable counts', () => {
  let s = { streak: 0, degraded: false };
  s = B.audibleDegradedStep(s.streak, 2, 1, 3); assert.deepEqual(s, { streak: 1, degraded: false });
  s = B.audibleDegradedStep(s.streak, 2, 1, 3); assert.deepEqual(s, { streak: 2, degraded: false });
  s = B.audibleDegradedStep(s.streak, 2, 0, 3); assert.deepEqual(s, { streak: 3, degraded: true });
  s = B.audibleDegradedStep(s.streak, 2, 1, 3); assert.equal(s.degraded, true);
  s = B.audibleDegradedStep(s.streak, 2, 2, 3); assert.deepEqual(s, { streak: 0, degraded: false });
  assert.deepEqual(B.audibleDegradedStep(0, 0, 0, 1), { streak: 0, degraded: false }, 'no targets is the unreachable alarm\'s case');
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
