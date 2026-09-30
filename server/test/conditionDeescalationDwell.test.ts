/**
 * v1.187.0 — the audible condition's DE-ESCALATION DWELL, driven through the REAL broadcast
 * monitor (startBroadcastMonitor) with Home Assistant mocked at the HTTP layer (undici
 * MockAgent), the Wyoming renderer injected, and a controllable clock.
 *
 * THE DEFECT (2026-09-29). The condition is re-derived from the warning count every tick, with
 * no hysteresis on the way down. One peer-voldiff episode (Core 1 pack 1, a single tracked
 * episode 15:06-15:44) flipped warning↔info each time a sibling pack's staggered ~3-min
 * reading moved the median and MAD, so the condition went green-then-yellow three times in ten
 * minutes — and "All clear. All stations report normal." was spoken at 15:20:51 while that
 * pack's spread was 58 mV and rising, with its push card still open.
 *
 * THE GUARD the review required: holding prevLevel at red while a cleared critical is confirmed
 * would silence a DIFFERENT critical arriving inside the hold at the same count, because newCrit
 * was count-based. New criticals (and, while a hold is pending, new warnings) are now detected
 * by fingerprint and are never held.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-dwell-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha,media_player.beta';
process.env.BROADCAST_SIP_TARGETS = '';
process.env.BROADCAST_ANNOUNCE_VOLUME = 'standing';
process.env.BROADCAST_MIN_SEVERITY = 'warning'; // a yellow condition is spoken
process.env.BROADCAST_QUIET_HOURS = '';
process.env.BROADCAST_BILINGUAL = 'false';
process.env.BROADCAST_END_OF_MESSAGE = 'false';
process.env.BROADCAST_REPEAT = '1';
process.env.BROADCAST_LEAD_SILENCE_MS = '0';
process.env.BROADCAST_ANNOUNCE_RETRIES = '0';
process.env.BROADCAST_HEALTH_PROBE_MS = '3600000';

const B = await import('../src/broadcast.js');
const { alertFingerprint } = await import('../src/redReplayGate.js');
const { restampAlertOnset } = await import('../src/alertOnset.js');
const { ALL_CLEAR_MESSAGE } = await import('../src/alertPriority.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
const SEC = 1_000;
const DWELL = B.CONDITION_CLEAR_DWELL_MS;

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer ── */
let announces = 0;
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/services', method: 'GET' })
  .reply(200, JSON.stringify([{ domain: 'music_assistant', services: { play_announcement: {} } }])).persist();
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply(200, JSON.stringify({ state: 'idle', attributes: {} })).persist();
ha.intercept({ path: '/core/api/services/music_assistant/play_announcement', method: 'POST' })
  .reply(() => {
    announces += 1;
    offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
    return { statusCode: 200, data: '[]' };
  }).delay(80).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-dwell-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
/** When set, the NEXT tick alone reads it (the tick reads the store exactly once), then `alerts`. */
let oneTick: Alert[] | null = null;
const store = {
  get: () => {
    if (oneTick != null) { const a = oneTick; oneTick = null; return { alerts: a }; }
    return { alerts };
  },
} as any;

/** The 09-29 peer outlier: ONE alert id whose severity flips warning↔info with the sibling MAD,
 *  and whose detail carries the live reading. */
const PEER_ID = 'peer-voldiff-COREXXX00XXX0001-1';
const peer = (severity: 'warning' | 'info', mv: number): Alert => ({
  id: PEER_ID, severity, category: 'Battery', source: 'learned', device: 'Core 1', coreNum: 1, packNum: 1,
  title: 'Cell voltage spread — peer outlier',
  detail: `Core 1 Pack 1 cell-voltage spread is ${mv} mV, ${mv - 20} mV higher than the sibling-pack median of 20 mV (peer z-score ${(mv / 7).toFixed(1)}).`,
} as Alert);
const CRIT_A: Alert = { id: 'dpu-err-DPU-A', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter error code', detail: 'x', fault: 'err7' } as Alert;
// Same id, DIFFERENT fault: a different critical on the same source (the redReplayGate case).
const CRIT_A2: Alert = { ...CRIT_A, fault: 'err9', title: 'Battery protection fault' } as Alert;
const CRIT_B: Alert = { id: 'vdiff-crit-DPU-B-2', severity: 'critical', category: 'Battery', device: 'Core 2', title: 'Cell imbalance', detail: 'spread 101 mV' } as Alert;
const WARN_K: Alert = { id: 'pack-temp-warn-DPU-A', severity: 'warning', category: 'Thermal', device: 'Core 1', title: 'Pack temperature high', detail: 'x' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
function rig(): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-dwell-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    count: (s) => logs.filter((l) => l.includes(s)).length,
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); },
  };
  live.push(r);
  return r;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(r: Rig, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${r.logs.join('\n')}`);
    await sleep(5);
  }
}
/** A completed condition broadcast of `level`. */
const played = (r: Rig, level: string) => r.count(`broadcast: ${level} → ok in`);
async function started(): Promise<Rig> {
  const r = rig();
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
  return r;
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = 0;
  alerts = [];
  oneTick = null;
  // The peer alert has stood past the v1.174.0 imbalance speak hold.
  restampAlertOnset(PEER_ID, Date.now() - 11 * MIN);
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

/* ══ the 09-29 flicker ═══════════════════════════════════════════════════════════════════ */

test('★★★ 09-29 replay: a peer outlier flickering warning↔info speaks ONE yellow and no all-clear', async () => {
  const r = await started();
  alerts = [peer('warning', 50)];
  await until(r, () => played(r, 'yellow') === 1, 'the first yellow (15:16:39)');

  // The recorded flips after it, as offsets: 15:17:59 info, 15:18:09 warning, 15:20:50 info,
  // 15:21:50 warning, 15:24:50 info, 15:26:10 warning, 15:36:30 info, 15:36:50 warning.
  const flips: Array<[number, 'warning' | 'info', number]> = [
    [80, 'info', 50], [10, 'warning', 50], [161, 'info', 58], [60, 'warning', 58],
    [180, 'info', 60], [80, 'warning', 60], [620, 'info', 101], [20, 'warning', 101],
  ];
  let holds = 0;
  let abandons = 0;
  for (const [dt, sev, mv] of flips) {
    offset += dt * SEC;
    alerts = [peer(sev, mv)];
    if (sev === 'info') {
      holds += 1;
      await until(r, () => r.count('yellow → green held') === holds, `hold ${holds}`);
    } else {
      abandons += 1;
      await until(r, () => r.count('abandoned after') === abandons, `abandon ${abandons}`);
    }
  }
  await sleep(60);
  assert.equal(announces, 1, 'the flicker spoke nothing after the first yellow');
  assert.equal(played(r, 'green'), 0, 'no all-clear was spoken while the warning stood');
  assert.ok(!r.has('condition transition → green'));
  assert.equal(r.count('again (flicker absorbed, nothing spoken)'), 4);
  assert.equal(r.mon.status().conditionLevel, 'yellow', 'the committed condition never left yellow');

  // A genuine recovery: the outlier clears and STAYS clear for the dwell → one all-clear.
  alerts = [];
  await until(r, () => r.count('yellow → green held') === 5, 'the final hold');
  offset += DWELL - 5 * SEC;
  await sleep(60);
  assert.equal(played(r, 'green'), 0, 'not before the dwell has elapsed');
  offset += 6 * SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  assert.equal(r.mon.status().lastSpokenMessage, ALL_CLEAR_MESSAGE);
  assert.equal(announces, 2);
});

test('★★ a yellow that clears and stays clear gets its all-clear after the dwell, not before', async () => {
  const r = await started();
  alerts = [WARN_K];
  await until(r, () => played(r, 'yellow') === 1, 'the yellow');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += DWELL - 10 * SEC;
  await sleep(60);
  assert.ok(!r.has('condition transition → green'), 'held for the full dwell');
  offset += 11 * SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
});

/* ══ the verifier's guard: a DIFFERENT critical at the same count ═══════════════════════════ */

test('★★★ a DIFFERENT critical replacing a cleared one inside the red hold is announced (same count)', async () => {
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red A');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the red hold');
  offset += 150 * SEC; // inside the 3-min dwell, past the 2-min same-level storm gap
  alerts = [CRIT_B]; // crit 1 → 1: a count cannot see it
  await until(r, () => played(r, 'red') === 2 || r.has('(storm gate)'), 'red B');
  assert.equal(played(r, 'red'), 2, 'the replacement critical was spoken');
  assert.ok(r.has('condition transition → red (new crit)'));
  assert.ok(r.has('abandoned after') && r.has('with a new critical'));
});

test('★★★ …and one replacing it in the SAME tick (no hold at all) — silent before v1.187.0', async () => {
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red A');
  offset += 150 * SEC;
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 2, 'red B');
  assert.ok(r.has('condition transition → red (new crit)'));
});

test('★★ a new FAULT under the same alert id is a new critical (fingerprint, not id)', async () => {
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red A err7');
  offset += 150 * SEC;
  alerts = [CRIT_A2];
  await until(r, () => played(r, 'red') === 2, 'red A err9');
});

test('★★ a critical that clears and RETURNS inside the dwell is not re-announced; a steady clear is', async () => {
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red A');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 60 * SEC;
  alerts = [CRIT_A];
  await until(r, () => r.has('abandoned after'), 'the flicker absorbed');
  offset += 5 * MIN;
  await sleep(60);
  assert.equal(announces, 1, 'the same critical returning is not news');
  alerts = [];
  await until(r, () => r.count('red → green held') === 2, 'the second hold');
  offset += DWELL + SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear once it has stood');
});

test('★★ review: a critical whose fault code ALTERNATES is announced once per identity per red episode, not on every flip', async () => {
  // One dpu-err id whose sysErrCode cycles between two values. Replacing the committed set on
  // every commit made each flip "new", and the klaxon sounded every time the 2-min gap lapsed.
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red A err7');
  offset += 150 * SEC;
  alerts = [CRIT_A2];
  await until(r, () => played(r, 'red') === 2, 'err9 — a fault not yet heard in this episode');
  for (const c of [CRIT_A, CRIT_A2, CRIT_A]) {
    offset += 150 * SEC; // past the same-level gap each time
    alerts = [c];
    await sleep(60);
  }
  await sleep(60);
  assert.equal(played(r, 'red'), 2, 'the flips back and forth are not news');
  assert.equal(r.count('condition transition → red'), 2);
  // A critical never counted in this episode still is.
  alerts = [CRIT_A, CRIT_B];
  await until(r, () => played(r, 'red') === 3, 'a third, different critical');
});

/* ══ a restart INSIDE the dwell (review) ═════════════════════════════════════════════════════ */

test('★★★ review: a restart inside the red→green dwell — the same critical re-raising in the next warm-up is announced', async () => {
  const RR = process.env.BROADCAST_RED_REPLAY_STATE_PATH!;
  const a = await started();
  alerts = [CRIT_A];
  await until(a, () => played(a, 'red') === 1, 'red A');
  assert.ok(JSON.parse(readFileSync(RR, 'utf8')).voicedFingerprint, 'a verified red is on record');
  alerts = [];
  await until(a, () => a.has('the red-replay evidence is cleared now'), 'the green observed under the held red');
  assert.equal(JSON.parse(readFileSync(RR, 'utf8')).voicedFingerprint, undefined, 'tombstoned on disk');
  offset += 150 * SEC; // still inside the 3-min dwell: the green has NOT committed
  await sleep(40);
  assert.ok(!a.has('condition transition → green'));
  a.stop(); // a restart (an auto-update deploy) inside the dwell

  const b = rig();
  await sleep(80); // the boot green is joined silently — it never wipes the evidence
  offset += 4 * MIN; // inside the 10-min warm-up window; clear ~6.5 min in all
  alerts = [CRIT_A];
  await until(b, () => played(b, 'red') === 1 || b.has('this standing fault was already announced'), 'the re-raised critical');
  assert.equal(played(b, 'red'), 1, 'a new event, as a committed green would have made it');
});

test('★★ review: a restart inside the dwell does not boot on a HEARD red — a standing yellow after it is spoken', async () => {
  const a = await started();
  alerts = [CRIT_A];
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === 'red', 'a heard red');
  alerts = [];
  await until(a, () => a.has('red → green held'), 'the hold');
  assert.equal(a.mon.status().conditionSpoken, false, 'demoted for the hold');
  a.stop();

  const b = rig();
  await sleep(80);
  assert.equal(b.mon.status().bootBaselineLevel, null, 'no heard baseline to continue');
  alerts = [WARN_K];
  await until(b, () => b.has('yellow held for boot confirmation') || b.has('matches pre-restart advisory'), 'the post-boot yellow');
  assert.ok(!b.has('matches pre-restart advisory'), 'not swallowed as a continuation of the cleared red');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the yellow');
});

test('★★ review: …while a flicker the dwell absorbs keeps the heard baseline (the v0.58.0 restart continuation)', async () => {
  const a = await started();
  alerts = [WARN_K];
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === 'yellow', 'a heard yellow');
  alerts = [];
  await until(a, () => a.has('yellow → green held'), 'the hold');
  assert.equal(a.mon.status().conditionSpoken, false);
  alerts = [WARN_K];
  await until(a, () => a.has('again (flicker absorbed, nothing spoken)'), 'the flicker absorbed');
  assert.equal(a.mon.status().conditionSpoken, true, 'restored: the household heard this level');
  a.stop();

  alerts = [];
  const b = rig();
  await sleep(80);
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  alerts = [WARN_K];
  await until(b, () => b.has('matches pre-restart advisory') || b.has('yellow held for boot confirmation'), 'the post-boot yellow');
  assert.ok(b.has('matches pre-restart advisory'), 'the standing warning is not re-spoken after the restart');
});

/* ══ red → yellow ═══════════════════════════════════════════════════════════════════════════ */

test('★★ red → a yellow that was already standing is held for the dwell, then spoken', async () => {
  const r = await started();
  alerts = [CRIT_A, WARN_K];
  await until(r, () => played(r, 'red') === 1, 'red with a standing warning');
  alerts = [WARN_K];
  await until(r, () => r.has('red → yellow held'), 'the hold');
  offset += 2 * MIN;
  await sleep(60);
  assert.equal(announces, 1, 'not yet');
  offset += DWELL - 2 * MIN + SEC;
  await until(r, () => played(r, 'yellow') === 1, 'the yellow after the dwell');
});

test('★★ a yellow↔green flicker below a cleared red commits YELLOW, never a false all-clear', async () => {
  const r = await started();
  alerts = [CRIT_A, peer('warning', 70)];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [peer('info', 70)]; // green
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 100 * SEC;
  alerts = [peer('warning', 70)]; // yellow, a KNOWN warning
  await sleep(60);
  offset += 50 * SEC;
  alerts = [peer('info', 70)];
  await sleep(60);
  offset += 40 * SEC; // below red 190 s; green only 40 s
  await sleep(60);
  assert.equal(announces, 1, 'green has not stood the dwell, so nothing yet');
  alerts = [peer('warning', 70)];
  await until(r, () => played(r, 'yellow') === 1, 'the yellow commits: below red for the dwell');
  assert.equal(played(r, 'green'), 0);
});

/* ══ nothing NEW ever waits ══════════════════════════════════════════════════════════════════ */

test('★★★ a NEW warning appearing below a held red is spoken at once', async () => {
  const r = await started();
  alerts = [CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 150 * SEC;
  alerts = [WARN_N];
  await until(r, () => played(r, 'yellow') === 1, 'the new warning');
  assert.ok(r.has('condition transition → yellow (new warning)'));
});

test('★★★ a NEW warning inside a held yellow→green is spoken at once (the old one returning is not)', async () => {
  const r = await started();
  alerts = [WARN_K];
  await until(r, () => played(r, 'yellow') === 1, 'yellow K');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += 150 * SEC;
  alerts = [WARN_N];
  await until(r, () => played(r, 'yellow') === 2, 'yellow N');
  assert.ok(r.has('condition transition → yellow (new warning)'));
});

test('★★ a NEW warning that the boot yellow confirmation holds is still spoken when it confirms', async () => {
  // Inside the warm-up window a fresh yellow must persist BOOT_YELLOW_CONFIRM_MS (v1.173.1). A new
  // warning arriving inside a held yellow→green must still read as new on every tick of that wait.
  const r = rig();
  await sleep(80); // green first tick; the 10-min warm-up window is open
  alerts = [WARN_K];
  await until(r, () => r.has('yellow held for boot confirmation'), 'the boot hold on K');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(r, () => played(r, 'yellow') === 1, 'yellow K confirmed');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the de-escalation hold');
  offset += 150 * SEC;
  alerts = [WARN_N];
  await until(r, () => r.count('yellow held for boot confirmation') === 2, 'the boot hold on the new warning');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC; // still inside the warm-up window
  await until(r, () => played(r, 'yellow') === 2, 'the new warning, once confirmed');
  assert.ok(r.has('condition transition → yellow (new warning)'));
});

test('★★ rises never wait: green → yellow → red each speak at once', async () => {
  const r = await started();
  alerts = [WARN_K];
  await until(r, () => played(r, 'yellow') === 1, 'yellow');
  alerts = [WARN_K, CRIT_A];
  await until(r, () => played(r, 'red') === 1, 'red — an escalation, inside the storm gap');
  assert.ok(!r.has('held'), 'no hold on the way up');
});

/* ══ log review 09-29: a critical that SOUNDED and is then held by a bounded mute ═══════════ */

/** CRIT_B on its next reading: the BMS is balancing again (a pack at 93%, below the top of
 *  charge), so vdiffCritMute holds it — annunciate:false with mutedBy set, as alerts.ts stamps it. */
const HELD_B: Alert = {
  ...CRIT_B, annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells',
  detail: 'spread 95 mV BMS is actively balancing the cells.',
} as Alert;

const ABSENT_HOLD = B.SOUNDED_VDIFF_ABSENT_HOLD_MS;
const HOLD_LINE = 'A cell-spread critical that sounded is held, not cleared';

/** A sounded cell-spread critical has CLEARED at the current tick: it is held for the absent hold
 *  (it may only be between two readings), then the lower level stands its own full dwell. */
async function clearAndWaitOutTheHolds(r: Rig, level: 'green' | 'yellow'): Promise<void> {
  await sleep(60); // the clear is observed: both holds are measured from here, not from the first green reading
  offset += ABSENT_HOLD - 5 * SEC;
  await sleep(60);
  assert.equal(played(r, level), 0, 'held between readings: not before it has been gone the absent hold');
  offset += 6 * SEC; // released
  await sleep(60); // the lower level's dwell starts now
  offset += DWELL - 5 * SEC;
  await sleep(60);
  assert.equal(played(r, level), 0, 'not before the clear has also stood the dwell');
  offset += 6 * SEC;
}

test('★★★ log review: a critical that SOUNDED and is then held by a bounded cell-spread mute is held, not cleared — no all-clear between two klaxons', async () => {
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'red: the cell-imbalance critical annunciates');
  // The next reading: balancing resumed, the critical is held by the balancing mute and no longer
  // counts. Merged v1.187.0 committed green after the dwell and spoke the all-clear.
  alerts = [HELD_B];
  await until(r, () => r.has('red → green held'), 'the hold');
  assert.ok(r.has(HOLD_LINE));
  offset += DWELL + 30 * SEC;
  await sleep(60);
  offset += 10 * MIN; // well past the dwell, the mute still holding
  await sleep(60);
  assert.equal(played(r, 'green'), 0, 'no all-clear while the critical that sounded is held');
  assert.ok(!r.has('condition transition → green'));
  assert.equal(r.mon.status().conditionLevel, 'red', 'the committed condition stays red');
  // The mute lapses and the critical annunciates again: a flicker the hold absorbs, not news.
  alerts = [CRIT_B];
  await until(r, () => r.has('abandoned after'), 'the flicker absorbed');
  await sleep(60);
  assert.equal(played(r, 'red'), 1, 'not a second klaxon for the same critical');
  assert.equal(announces, 1);
  // Held once more, then the critical genuinely CLEARS: the all-clear follows the absent hold and
  // its own full dwell.
  alerts = [HELD_B];
  await until(r, () => r.count('red → green held') === 2, 'the second hold');
  offset += 5 * MIN;
  await sleep(60);
  alerts = [];
  await clearAndWaitOutTheHolds(r, 'green');
  await until(r, () => played(r, 'green') === 1, 'the all-clear once the critical has cleared');
  assert.equal(r.mon.status().lastSpokenMessage, ALL_CLEAR_MESSAGE);
  assert.equal(announces, 2);
});

test('★★ log review: …and a warning that stood with it is not committed below the held red either', async () => {
  const r = await started();
  alerts = [CRIT_B, WARN_K];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [HELD_B, WARN_K];
  await until(r, () => r.has('red → yellow held'), 'the hold');
  offset += DWELL + 10 * MIN;
  await sleep(60);
  assert.equal(played(r, 'yellow'), 0, 'no de-escalation below a critical that sounded and is held');
  assert.equal(r.mon.status().conditionLevel, 'red');
  alerts = [WARN_K]; // the critical clears
  await clearAndWaitOutTheHolds(r, 'yellow');
  await until(r, () => played(r, 'yellow') === 1, 'the yellow once the clear has stood the holds');
});

test('★★ log review: a muted critical that never SOUNDED holds nothing (the all-clear after a cleared warning is spoken, as before)', async () => {
  const r = await started();
  alerts = [WARN_K];
  await until(r, () => played(r, 'yellow') === 1, 'yellow');
  alerts = [HELD_B]; // muted from its first reading: never counted, never heard
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  assert.ok(!r.has(HOLD_LINE));
});

test('★★ log review: a critical that annunciated on ONE reading — the tick that commits the red — and is muted from the next is held too', async () => {
  // Nothing but the commit can record it: the tick-time recording needs the committed level to be
  // red already, and every tick after the commit reads it muted.
  const r = await started();
  alerts = [HELD_B]; // every later reading
  oneTick = [CRIT_B]; // the one reading at which it annunciated
  await until(r, () => played(r, 'red') === 1, 'the red');
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += DWELL + 10 * MIN;
  await sleep(60);
  assert.equal(played(r, 'green'), 0, 'no all-clear while the critical that sounded is held');
  assert.equal(r.mon.status().conditionLevel, 'red');
});

test('★★★ log review (verifier probe 1): sounded → gone 60 s → loud again inside the hold → muted: still held, no all-clear', async () => {
  // The return inside the hold is a flicker the hold absorbs, so nothing is committed; the sounded
  // record must survive both the absence and that uncommitted return.
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 60 * SEC;
  await sleep(40);
  alerts = [CRIT_B];
  await until(r, () => r.has('flicker absorbed'), 'loud again: absorbed');
  offset += 30 * SEC;
  await sleep(40);
  alerts = [HELD_B];
  await until(r, () => r.count('red → green held') === 2, 'held again');
  for (let i = 0; i < 4; i++) { offset += 5 * MIN; await sleep(40); }
  assert.equal(played(r, 'green'), 0, '"All clear" is not spoken with the critical\'s card open');
  assert.ok(!r.has('condition transition → green'));
  assert.equal(r.mon.status().conditionLevel, 'red');
  assert.equal(played(r, 'red'), 1);
});

test('★★★ log review (verifier probe 1b): a critical counted under a committed red is recorded even when nothing commits', async () => {
  // Gone longer than the absent hold (released, the green dwell running), then loud again inside
  // that dwell: absorbed, nothing committed. Only the tick's own recording keeps it "sounded".
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += ABSENT_HOLD + 10 * SEC; // released: the green dwell starts
  await sleep(40);
  offset += 60 * SEC; // inside the dwell
  await sleep(40);
  alerts = [CRIT_B];
  await until(r, () => r.has('flicker absorbed'), 'loud again: absorbed');
  alerts = [HELD_B];
  await until(r, () => r.count('red → green held') === 2, 'held again');
  for (let i = 0; i < 4; i++) { offset += 5 * MIN; await sleep(40); }
  assert.equal(played(r, 'green'), 0, 'no all-clear between two klaxons');
  assert.equal(r.mon.status().conditionLevel, 'red');
});

test('★★★ log review (verifier probe 2): a spread that follows the charge current — loud on alternate readings, gone 200 s between — sounds ONE red and no all-clear', async () => {
  // 95 / 45 mV on alternate BMS readings: the critical stands ~180 s, then is absent ~200 s (the
  // monitor publishes on a 20 s grid) — longer than the dwell. Before, green committed between
  // readings: 8 red klaxons and 7 all-clears over 8 cycles.
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'the first loud reading');
  for (let i = 0; i < 8; i++) {
    offset += 150 * SEC; // the loud reading stands (the clip took 30 s of it the first time)
    await sleep(30);
    alerts = [];
    await sleep(30);
    offset += 200 * SEC;
    await sleep(30);
    alerts = [CRIT_B];
    await sleep(30);
  }
  // One missed BMS reading: gone for two periods.
  alerts = [];
  await sleep(30);
  offset += 380 * SEC;
  await sleep(30);
  alerts = [CRIT_B];
  await sleep(40);
  assert.equal(played(r, 'red'), 1, 'one klaxon for the fault');
  assert.equal(played(r, 'green'), 0, 'no all-clear between its readings');
  assert.equal(announces, 1);
  assert.equal(r.mon.status().conditionLevel, 'red');
  // …and when it genuinely clears, exactly one all-clear.
  alerts = [];
  await clearAndWaitOutTheHolds(r, 'green');
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  offset += 20 * MIN;
  await sleep(60);
  assert.equal(played(r, 'green'), 1, 'once');
  assert.equal(announces, 2);
});

test('★★ log review: a genuine clear of a sounded cell-spread critical speaks exactly one all-clear, after the absent hold and the dwell', async () => {
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'red');
  offset += 3 * MIN;
  alerts = [];
  await clearAndWaitOutTheHolds(r, 'green');
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  assert.equal(r.mon.status().lastSpokenMessage, ALL_CLEAR_MESSAGE);
  offset += 30 * MIN;
  await sleep(60);
  assert.equal(announces, 2, 'one red, one all-clear');
});

test('★★★ log review (verifier probe 3): a NEW warning below a held sounded critical is spoken once; the committed red stands, and the critical sounding again is not a second klaxon', async () => {
  const r = await started();
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'red');
  alerts = [HELD_B];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN; // past the 2-min same-level gap: the new warning is not refused
  alerts = [HELD_B, WARN_N];
  await until(r, () => played(r, 'yellow') === 1, 'the new warning, spoken at once');
  assert.ok(r.has('condition transition → yellow (new warning) spoken; the committed condition stays red'));
  assert.equal(r.mon.status().conditionLevel, 'red', 'the committed condition stays red');
  offset += 3 * MIN;
  alerts = [CRIT_B, WARN_N]; // the held critical annunciates again
  await sleep(80);
  offset += 3 * MIN;
  await sleep(60);
  assert.equal(played(r, 'red'), 1, 'not a second klaxon: the red episode was never ended');
  alerts = [HELD_B, WARN_N];
  await sleep(40);
  offset += DWELL + 10 * MIN;
  await sleep(60);
  assert.equal(played(r, 'yellow'), 1, 'the warning was spoken once');
  assert.equal(r.mon.status().conditionLevel, 'red');
  assert.equal(announces, 2);
});

test('★★ log review: …and inside the boot warm-up, a new warning adopted as a restart continuation keeps the held red committed too', async () => {
  const a = await started();
  alerts = [WARN_K];
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === 'yellow', 'a heard yellow');
  a.stop();

  alerts = [];
  const b = rig();
  await sleep(80); // the boot green is joined silently
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  alerts = [CRIT_B];
  await until(b, () => played(b, 'red') === 1, 'the red: an escalation over the heard yellow');
  alerts = [HELD_B];
  await until(b, () => b.has('red → green held'), 'the hold');
  alerts = [HELD_B, WARN_K]; // new to this red episode, and the level heard before the restart
  await until(b, () => b.has('matches pre-restart advisory'), 'adopted silently as a restart continuation');
  assert.equal(b.mon.status().conditionLevel, 'red', 'the held red stays committed');
  alerts = [CRIT_B, WARN_K];
  await sleep(80);
  assert.equal(played(b, 'red'), 1);
});

/* ── pure pieces ─────────────────────────────────────────────────────────────────────────── */

test('soundedCriticalHeld — a critical counted at a committed red, held by a bounded mute or (a cell-spread critical) between its readings', () => {
  const fpB = alertFingerprint(CRIT_B);
  const fpA = alertFingerprint(CRIT_A);
  const t = 50_000_000;
  // Held: sounded, present, mutedBy set.
  assert.equal(B.soundedCriticalHeld([HELD_B], new Map([[fpB, t]]), t), true);
  // Never sounded in this episode: nothing is held.
  assert.equal(B.soundedCriticalHeld([HELD_B], new Map(), t), false);
  // Muted by POLICY (a bench spare / off-panel Core: no mutedBy): not a bounded mute.
  const policy = { ...CRIT_B, annunciate: false, muteReason: 'bench spare' } as Alert;
  assert.equal(B.soundedCriticalHeld([policy], new Map([[fpB, t]]), t), false);
  // Still annunciating: it is counted, and the level is red anyway.
  assert.equal(B.soundedCriticalHeld([CRIT_B], new Map([[fpB, t]]), t), false);
  // Present: its last-present tick is refreshed.
  const seen = new Map([[fpB, t - 10 * MIN]]);
  B.soundedCriticalHeld([HELD_B], seen, t);
  assert.equal(seen.get(fpB), t);
  // ABSENT, a cell-spread critical: held until it has been gone the absent hold, then released.
  assert.equal(B.SOUNDED_VDIFF_ABSENT_HOLD_MS, 7 * MIN, 'two ~180 s BMS reading periods plus a 20 s monitor tick, rounded up');
  const gone = new Map([[fpB, t]]);
  assert.equal(B.soundedCriticalHeld([], gone, t + ABSENT_HOLD - 1), true, 'between readings');
  assert.equal(gone.get(fpB), t, 'the last-present tick is not refreshed while it is absent');
  assert.equal(B.soundedCriticalHeld([], gone, t + ABSENT_HOLD), false, 'released');
  assert.deepEqual([...gone.keys()], [], 'and forgotten');
  // ABSENT, any other critical: released and forgotten the tick it clears, as before.
  const sounded = new Map([[fpB, t], [fpA, t]]);
  assert.equal(B.soundedCriticalHeld([CRIT_B], sounded, t + 1), false);
  assert.deepEqual([...sounded.keys()], [fpB], 'the cleared non-cell-spread critical is forgotten');
  // A cleared cell-spread critical, once released, that returns muted never sounded in its new
  // episode: nothing is held.
  const released = new Map([[fpB, t]]);
  assert.equal(B.soundedCriticalHeld([], released, t + ABSENT_HOLD), false);
  assert.equal(B.soundedCriticalHeld([HELD_B], released, t + ABSENT_HOLD + 1), false);
});

test('deescalationDue — green needs GREEN to have stood; yellow (from red) needs below-red to have stood', () => {
  const t = 10_000_000;
  assert.equal(B.CONDITION_CLEAR_DWELL_MS, 3 * MIN, 'the push path\'s VDIFF_RESOLVE_DWELL_MS');
  assert.equal(B.deescalationDue('green', t - 10 * MIN, t - DWELL, t), true);
  assert.equal(B.deescalationDue('green', t - 10 * MIN, t - DWELL + 1, t), false, 'below red long enough is not enough for green');
  assert.equal(B.deescalationDue('green', null, null, t), false);
  assert.equal(B.deescalationDue('yellow', t - DWELL, null, t), true);
  assert.equal(B.deescalationDue('yellow', t - DWELL + 1, null, t), false);
  assert.equal(B.deescalationDue('yellow', null, null, t), false);
  assert.equal(B.deescalationDue('red', null, null, t), true, 'red is never held');
});

test('hasNewIdentity — any fingerprint not in the committed set', () => {
  assert.equal(B.hasNewIdentity(['a', 'b'], new Set(['a', 'b', 'c'])), false);
  assert.equal(B.hasNewIdentity(['a', 'd'], new Set(['a', 'b'])), true);
  assert.equal(B.hasNewIdentity([], new Set(['a'])), false);
});

test('conditionFromAlerts — warningFingerprints: counted warnings only, stable while the reading drifts', () => {
  const a = B.conditionFromAlerts([peer('warning', 50), CRIT_A, { ...WARN_K, annunciate: false } as Alert]);
  const b = B.conditionFromAlerts([peer('warning', 97), CRIT_A]);
  assert.equal(a.warningFingerprints.length, 1, 'a non-annunciating warning is not counted');
  assert.deepEqual(a.warningFingerprints, b.warningFingerprints, 'the live mV/z in the detail is not identity');
  assert.deepEqual(B.conditionFromAlerts([peer('info', 50)]).warningFingerprints, []);
});
