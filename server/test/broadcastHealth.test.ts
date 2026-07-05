import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  broadcastHealthAlert,
  isAudibleHealthAlert,
  getBroadcastHealth,
  setBroadcastHealth,
  resetBroadcastHealth,
  AUDIBLE_UNREACHABLE_ALERT_ID,
  type BroadcastHealth,
} from '../src/broadcastHealth.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import type { Alert } from '../src/alerts.js';

/**
 * v0.84.0 — AUDIBLE-DELIVERY SAFETY NET.
 * The audible channel can be ENABLED yet reach no speaker (Music Assistant in
 * setup_error → its media_players go unavailable) with nothing to say so. These
 * pin the self-alert builder: it fires ONLY on a confirmed unreachable-while-
 * enabled state, never at boot (null), pushes (NOT annunciate:false), and is
 * excluded from the audible condition so it can't circular-chime.
 */

const NOW = 1_800_000_000_000;
const H = (over: Partial<BroadcastHealth>): BroadcastHealth => ({
  enabled: true, supervised: true, targetCount: 2, usableTargets: 0,
  musicAssistantAvailable: false, reachable: false, reason: 'all targets unavailable',
  lastProbeAt: NOW, ...over,
});

test('broadcastHealthAlert — confirmed unreachable while enabled → a WARNING push', () => {
  const a = broadcastHealthAlert(H({}), NOW);
  assert.ok(a);
  assert.equal(a!.id, AUDIBLE_UNREACHABLE_ALERT_ID);
  assert.equal(a!.severity, 'warning');
  assert.equal(a!.category, 'Connectivity');
  assert.equal(a!.priority, 'medium');
  assert.match(a!.detail, /none of the 2 configured speaker\(s\) are reachable/);
  assert.match(a!.detail, /Push alerts still work/);
});

test('broadcastHealthAlert — MUST push: it is NOT annunciate:false (that would suppress the push too)', () => {
  const a = broadcastHealthAlert(H({}), NOW);
  // The whole point is the WORKING push channel reports the dead audible channel.
  // annunciate:false would gate the push out — so it must be absent/true.
  assert.notEqual(a!.annunciate, false);
});

test('broadcastHealthAlert — null reachability (unprobed / boot / transient) never fires', () => {
  assert.equal(broadcastHealthAlert(H({ reachable: null }), NOW), null);
});

test('broadcastHealthAlert — reachable true never fires', () => {
  assert.equal(broadcastHealthAlert(H({ reachable: true, usableTargets: 2 }), NOW), null);
});

test('broadcastHealthAlert — disabled audible never fires (operator chose silence)', () => {
  assert.equal(broadcastHealthAlert(H({ enabled: false }), NOW), null);
});

test('broadcastHealthAlert — unsupervised (not under HA) never fires (audible is N/A)', () => {
  assert.equal(broadcastHealthAlert(H({ supervised: false }), NOW), null);
});

test('broadcastHealthAlert — no speakers configured gives the empty-targets wording', () => {
  const a = broadcastHealthAlert(H({ targetCount: 0, usableTargets: 0 }), NOW);
  assert.ok(a);
  assert.match(a!.detail, /no speakers are configured/);
});

test('broadcastHealthAlert — the probe reason flows into the detail verbatim (not-found vs unavailable distinction)', () => {
  // The probe sets reason to distinguish an all-null read (speakers NOT FOUND —
  // MA setup_error removes its media_players, or the HA API is down) from entities
  // reporting `unavailable` (integration loaded, speaker offline). Whichever it
  // is, the builder must surface it so operator triage isn't misdirected.
  const gone = broadcastHealthAlert(H({ reason: 'configured speaker(s) not found in Home Assistant — Music Assistant is likely down (its media_players disappear in setup_error), or the HA API is unreachable' }), NOW);
  assert.match(gone!.detail, /Music Assistant is likely down/);
  assert.match(gone!.detail, /HA API is unreachable/);
  const offline = broadcastHealthAlert(H({ reason: 'all 2 configured speaker(s) report unavailable (Music Assistant or the speakers may be down)' }), NOW);
  assert.match(offline!.detail, /report unavailable/);
});

test('isAudibleHealthAlert — matches only the audible-health id', () => {
  assert.equal(isAudibleHealthAlert({ id: AUDIBLE_UNREACHABLE_ALERT_ID }), true);
  assert.equal(isAudibleHealthAlert({ id: 'system-outage-123' }), false);
  assert.equal(isAudibleHealthAlert({ id: 'backup-soc-20' }), false);
});

test('get/set/reset — singleton round-trips and resets to unprobed', () => {
  setBroadcastHealth(H({ reachable: true, usableTargets: 2 }));
  assert.equal(getBroadcastHealth().reachable, true);
  resetBroadcastHealth();
  assert.equal(getBroadcastHealth().reachable, null); // unprobed → never alarms
  assert.equal(broadcastHealthAlert(getBroadcastHealth(), NOW), null);
});

test('conditionFromAlerts — the audible-health warning does NOT raise the audible condition (no circular chime)', () => {
  const audible = broadcastHealthAlert(H({}), NOW)!;
  // A push-worthy warning that must never chime: excluded by id → stays green.
  assert.equal(conditionFromAlerts([audible]).level, 'green');
  assert.equal(conditionFromAlerts([audible]).warn, 0);
  // A NORMAL warning with the same shape DOES raise it to yellow — proving the
  // exclusion (not annunciate) is what changed it.
  const normal: Alert = { ...audible, id: 'connectivity-warn-x' };
  assert.equal(conditionFromAlerts([normal]).level, 'yellow');
});
