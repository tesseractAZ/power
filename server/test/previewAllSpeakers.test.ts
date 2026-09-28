/**
 * v1.186.4 — the Alert Console's "On speakers" preview, driven through the REAL broadcast
 * monitor with Home Assistant mocked at the HTTP layer (the broadcastIntegrity.test.ts rig).
 *
 * The preview called music_assistant.play_announcement alone, so the SIP cordless never heard
 * a preview, and /api/alert-preview took the four priorities only, so the all-clear tone could
 * not be heard on a speaker before a real recovery played it.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-pvall-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.CHIME_CONFIG_PATH = resolve(ROOT, 'chime-config.json');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha';
process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
process.env.BROADCAST_ANNOUNCE_VOLUME = 'standing';
process.env.BROADCAST_QUIET_HOURS = '';
process.env.BROADCAST_BILINGUAL = 'false';
process.env.BROADCAST_END_OF_MESSAGE = 'false';
process.env.BROADCAST_REPEAT = '1';
process.env.BROADCAST_LEAD_SILENCE_MS = '0';
process.env.BROADCAST_ANNOUNCE_RETRIES = '0';
process.env.BROADCAST_HEALTH_PROBE_MS = '3600000';

const B = await import('../src/broadcast.js');
const { ALL_CLEAR_PREVIEW_MESSAGE } = await import('../src/alertPriority.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

let announces: Array<{ entity_id: string | string[]; url: string }> = [];
let sipPlays: Array<{ entity_id: string; media_content_id: string }> = [];
let sipStatus = 200;
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
  .reply((opts) => { announces.push(JSON.parse(String(opts.body))); return { statusCode: 200, data: '[]' }; }).persist();
ha.intercept({ path: '/core/api/services/media_player/play_media', method: 'POST' })
  .reply((opts) => { sipPlays.push(JSON.parse(String(opts.body))); return { statusCode: sipStatus, data: '[]' }; }).persist();

const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-pvall-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
const store = { get: () => ({ alerts: [] }) } as any;
const logs: string[] = [];
const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-pvall-cache-'));
const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
  klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
});
// The preview's own cooldown (PREVIEW_COOLDOWN_MS, 2 s) — each test waits it out.
const cooldown = () => new Promise((res) => setTimeout(res, 2_100));

beforeEach(async () => { await cooldown(); announces = []; sipPlays = []; sipStatus = 200; });
after(async () => {
  mon.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  for (const d of [ROOT, KLAXON, cacheDir]) rmSync(d, { recursive: true, force: true });
});

test('★★★ a speaker preview plays on the cordless as well as the Music Assistant speakers', async () => {
  const r = await mon.preview('high', 'speakers');
  assert.equal(r.ok, true, r.error);
  assert.equal(announces.length, 1, 'Music Assistant got the preview');
  assert.equal(sipPlays.length, 1, 'the cordless got the preview');
  assert.equal(sipPlays[0].entity_id, 'media_player.cordless');
  assert.equal(sipPlays[0].media_content_id, announces[0].url, 'both speakers play the same render');
  assert.equal(r.delivered, 2);
});

test('★★ the all-clear previews on the speakers with the recovery broadcast\'s words', async () => {
  const r = await mon.preview('clear', 'speakers');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.spokenText, ALL_CLEAR_PREVIEW_MESSAGE);
  assert.equal(announces.length, 1);
  assert.equal(sipPlays.length, 1);
  assert.ok(logs.some((l) => l.includes('broadcast: preview clear (green) → played to 2 target(s)')), logs.join('\n'));
});

test('a refused cordless fails the preview and says so', async () => {
  sipStatus = 500;
  const r = await mon.preview('low', 'speakers');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^SIP play_media: media_player\.cordless: /);
  assert.equal(r.delivered, 1, 'Music Assistant still played it');
});

test('a browser preview touches no speaker', async () => {
  const r = await mon.preview('clear', 'browser');
  assert.equal(r.ok, true, r.error);
  assert.equal(announces.length + sipPlays.length, 0);
});
