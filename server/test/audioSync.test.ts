import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferProtocol,
  defaultBufferMs,
  groupByProtocol,
  scheduleStagger,
  type SpeakerProfile,
} from '../src/speakerProfiles.js';
import { buildAlertMessage } from '../src/ttsService.js';
import type { Alert } from '../src/alerts.js';

/**
 * v0.9.29 — audio sync + TTS tests.
 *
 * Networked TTS calls (callHaService) are tested manually via the live
 * /api/broadcast/test endpoint against a real HA. These unit tests cover
 * the pure functions:
 *
 *   - inferProtocol / defaultBufferMs: entity → protocol mapping
 *   - groupByProtocol / scheduleStagger: protocol → fire-schedule
 *   - buildAlertMessage: alert → spoken sentence
 */

/* ─── protocol detection ─────────────────────────────────────────── */

test('inferProtocol — HomePod by entity name', () => {
  assert.equal(inferProtocol('media_player.homepod', {}), 'airplay');
  assert.equal(inferProtocol('media_player.kitchen_homepod', {}), 'airplay');
});

test('inferProtocol — HomePod by model attribute', () => {
  assert.equal(inferProtocol('media_player.foo', { model: 'HomePod' }), 'airplay');
});

test('inferProtocol — Sonos by entity name', () => {
  assert.equal(inferProtocol('media_player.family_room_sonos', {}), 'sonos');
  assert.equal(inferProtocol('media_player.living_room_sonos_arc', {}), 'sonos');
});

test('inferProtocol — thermostat speakers map to cast', () => {
  assert.equal(inferProtocol('media_player.hallway_thermostat', {}), 'cast');
  assert.equal(inferProtocol('media_player.guest_hallway_thermostat', {}), 'cast');
});

test('inferProtocol — v0.9.31: soundbar entities map to sonos (Beam/Arc/Ray)', () => {
  assert.equal(inferProtocol('media_player.family_room_soundbar_2', {}), 'sonos');
  assert.equal(inferProtocol('media_player.sonos_arc', {}), 'sonos');
});

test('inferProtocol — v0.9.31: MA provider attr is authoritative', () => {
  // Even if entity name says "soundbar", MA-reported provider trumps it.
  assert.equal(inferProtocol('media_player.foo', { provider: 'sonos' }), 'sonos');
  assert.equal(inferProtocol('media_player.foo', { provider: 'airplay' }), 'airplay');
  assert.equal(inferProtocol('media_player.foo', { provider: 'chromecast' }), 'cast');
});

test('inferProtocol — v0.9.31: device currently playing AirPlay reports as airplay', () => {
  // Sonos device showing AirPlay as its current source → treat as airplay
  // for staggering since its current playback path IS airplay.
  assert.equal(inferProtocol('media_player.unknown_speaker', { source: 'AirPlay' }), 'airplay');
});

test('inferProtocol — google/nest map to cast', () => {
  assert.equal(inferProtocol('media_player.nest_mini_kitchen', {}), 'cast');
  assert.equal(inferProtocol('media_player.google_home_office', {}), 'cast');
});

test('inferProtocol — Echo by entity name or platform', () => {
  assert.equal(inferProtocol('media_player.echo_dot_bedroom', {}), 'echo');
  assert.equal(inferProtocol('media_player.foo', { platform: 'alexa_media' }), 'echo');
});

test('inferProtocol — unknown is unknown (treated as cast at fire-time)', () => {
  assert.equal(inferProtocol('media_player.mystery_box', {}), 'unknown');
});

test('defaultBufferMs — airplay > cast > sonos', () => {
  assert.ok(defaultBufferMs('airplay') > defaultBufferMs('cast'));
  assert.ok(defaultBufferMs('cast') > defaultBufferMs('sonos'));
});

/* ─── grouping + staggering ──────────────────────────────────────── */

test('groupByProtocol — collapses targets of same protocol into one group', () => {
  const profiles: SpeakerProfile[] = [
    { entity_id: 'media_player.homepod_a',     friendly_name: 'A', protocol: 'airplay', bufferMs: 2000 },
    { entity_id: 'media_player.homepod_b',     friendly_name: 'B', protocol: 'airplay', bufferMs: 2000 },
    { entity_id: 'media_player.sonos_soundbar', friendly_name: 'C', protocol: 'sonos',   bufferMs: 300 },
  ];
  const groups = groupByProtocol(profiles);
  assert.equal(groups.length, 2);
  // Longest buffer first.
  assert.equal(groups[0].protocol, 'airplay');
  assert.equal(groups[0].targets.length, 2);
  assert.equal(groups[1].protocol, 'sonos');
  assert.equal(groups[1].targets.length, 1);
});

test('scheduleStagger — longest-buffer group fires at 0, faster groups at +delta', () => {
  const groups = [
    { protocol: 'airplay' as const, bufferMs: 2000, targets: ['media_player.hp1', 'media_player.hp2'] },
    { protocol: 'cast' as const,    bufferMs: 1000, targets: ['media_player.cast1'] },
    { protocol: 'sonos' as const,   bufferMs: 300,  targets: ['media_player.sonos1'] },
  ];
  const sched = scheduleStagger(groups);
  assert.equal(sched.length, 3);
  assert.equal(sched[0].fireAtMs, 0,    'airplay fires immediately');
  assert.equal(sched[1].fireAtMs, 1000, 'cast fires +1000ms (so it starts at 2000ms wall-clock just like airplay)');
  assert.equal(sched[2].fireAtMs, 1700, 'sonos fires +1700ms (starts at 2000ms wall-clock)');
});

test('scheduleStagger — single group fires at 0', () => {
  const groups = [{ protocol: 'sonos' as const, bufferMs: 300, targets: ['media_player.x'] }];
  const sched = scheduleStagger(groups);
  assert.equal(sched.length, 1);
  assert.equal(sched[0].fireAtMs, 0);
});

test('scheduleStagger — empty input → empty schedule', () => {
  assert.deepEqual(scheduleStagger([]), []);
});

/* ─── message building ───────────────────────────────────────────── */

test('buildAlertMessage — green → all clear', () => {
  const m = buildAlertMessage('green', []);
  assert.match(m, /All clear/);
});

test('buildAlertMessage — red with critical alert names category + repeats', () => {
  const alerts: Alert[] = [{
    id: 'soh-crit-DEADBEEF12345678-2',
    severity: 'critical',
    category: 'Battery',
    device: 'Core 3',
    title: 'Pack health critical',
    detail: 'Core 3 Pack 2 SoH 68.2% (critical < 70%).',
    coreNum: 3,
    packNum: 2,
  }];
  const m = buildAlertMessage('red', alerts);
  assert.match(m, /Red alert/);
  assert.match(m, /Battery system/);
  assert.match(m, /Core three pack two/);
  assert.match(m, /state of health/);  // SoH → state of health
  assert.match(m, /percent/);          // % → percent
  assert.match(m, /Acknowledge at console/);
  assert.match(m, /Repeat/);
});

test('buildAlertMessage — yellow expands MPPT / HV', () => {
  const alerts: Alert[] = [{
    id: 'mppt-hv', severity: 'warning', category: 'Solar', device: 'Core 5',
    title: 'HV MPPT error code',
    detail: 'Core 5 HV solar reports error code 17.',
    coreNum: 5,
  }];
  const m = buildAlertMessage('yellow', alerts);
  assert.match(m, /Yellow alert/);
  assert.match(m, /Solar system/);
  assert.match(m, /Core five/);
  assert.match(m, /high voltage/);  // HV → high voltage
  assert.match(m, /M P P T/);       // MPPT → M P P T (spelled)
  assert.doesNotMatch(m, /Repeat/, 'warning shouldn\'t repeat');
});

test('buildAlertMessage — red without alerts still says red alert', () => {
  const m = buildAlertMessage('red', []);
  assert.match(m, /Red alert/);
  assert.match(m, /Critical condition/i);
});

test('buildAlertMessage — Battery > Solar in priority order', () => {
  const alerts: Alert[] = [
    { id: 'a', severity: 'critical', category: 'Solar',   device: 'core 5', title: 'Solar problem',   detail: 'd', coreNum: 5 },
    { id: 'b', severity: 'critical', category: 'Battery', device: 'core 3', title: 'Battery problem', detail: 'd', coreNum: 3 },
  ];
  const m = buildAlertMessage('red', alerts);
  // Battery alert should be the one featured.
  assert.match(m, /Battery problem/);
  assert.doesNotMatch(m, /Solar problem/);
});
