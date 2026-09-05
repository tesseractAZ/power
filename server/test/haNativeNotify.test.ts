import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildMobilePushPayload, parsePushTargets, isConfigured, reachesAPhone,
  loadNotifyConfig, type NotifyConfig,
} from '../src/notify.js';

/**
 * v1.124.0 — notifications are Home-Assistant-native, and only that.
 *
 * THE DEFECT: the live channel delivered `persistent_notification.create` only —
 * a card in the HA drawer, which the companion app shows when you open it. No OS
 * push, no lock-screen alert, no sound, and no `mobile_app` reference anywhere in
 * the repo. Away or asleep, a critical reached nobody.
 */

const msg = (severity: 'critical' | 'warning' | 'info' | 'resolved', dedupId?: string) => ({
  title: 'Backup pool critical', body: 'Backup pool 4%', severity, dedupId,
});

/* ── the critical payload (companion-app spec) ────────────────────────────── */

test('THE FIX: a critical carries the documented DND bypass for BOTH platforms', () => {
  const p = buildMobilePushPayload(msg('critical', 'soc-low-CORE1'), { criticalBypassDnd: true }) as any;
  assert.equal(p.title, 'Backup pool critical');
  assert.equal(p.message, 'Backup pool 4%');
  // iOS — critical alerts sound through Do Not Disturb and the mute switch.
  assert.deepEqual(p.data.push, { sound: { name: 'default', critical: 1, volume: 1.0 } });
  // Android — alarm_stream sounds regardless of ringer mode.
  assert.equal(p.data.ttl, 0);
  assert.equal(p.data.priority, 'high');
  assert.equal(p.data.channel, 'alarm_stream');
});

test('a WARNING never breaks Do Not Disturb, even with the bypass on', () => {
  const p = buildMobilePushPayload(msg('warning', 'x'), { criticalBypassDnd: true }) as any;
  assert.equal(p.data.push, undefined, 'no critical sound payload');
  assert.equal(p.data.channel, undefined, 'no alarm_stream');
  assert.equal(p.data.priority, undefined);
});

test('an owner who turns the bypass OFF still gets a prompt critical, just not a loud one', () => {
  const p = buildMobilePushPayload(msg('critical', 'x'), { criticalBypassDnd: false }) as any;
  assert.equal(p.data.push, undefined, 'DND is respected');
  assert.equal(p.data.channel, undefined);
  assert.equal(p.data.ttl, 0, 'but it is still delivered immediately');
  assert.equal(p.data.priority, 'high');
});

test('the phone notification dedupes on the SAME id as the drawer card', () => {
  const a = buildMobilePushPayload(msg('critical', 'soc-low-CORE1'), { criticalBypassDnd: true }) as any;
  const b = buildMobilePushPayload(msg('resolved', 'soc-low-CORE1'), { criticalBypassDnd: true }) as any;
  assert.equal(a.data.tag, b.data.tag, 'a resolve supersedes the alert it closes');
  const other = buildMobilePushPayload(msg('critical', 'soc-low-CORE2'), { criticalBypassDnd: true }) as any;
  assert.notEqual(a.data.tag, other.data.tag, 'distinct subjects stay distinct');
  assert.match(String(a.data.tag), /^[a-z0-9_]+$/, 'HA-safe slug');
});

/* ── target parsing ───────────────────────────────────────────────────────── */

test('targets accept the notify. prefix or not, and reject junk', () => {
  assert.deepEqual(parsePushTargets('notify.mobile_app_iphone'), ['mobile_app_iphone']);
  assert.deepEqual(parsePushTargets(' mobile_app_iphone , notify.mobile_app_ipad '),
    ['mobile_app_iphone', 'mobile_app_ipad']);
  assert.deepEqual(parsePushTargets('notify.notify'), ['notify']);
  assert.deepEqual(parsePushTargets(''), []);
  assert.deepEqual(parsePushTargets(undefined), []);
  // A service name is a slug; anything else would build a bad service call.
  assert.deepEqual(parsePushTargets('mobile_app_iphone, bad name!, ../etc'), ['mobile_app_iphone']);
});

/* ── "configured" vs "actually reaches a phone" ───────────────────────────── */

const base: NotifyConfig = {
  channel: 'ha', minSeverity: 'warning', notifyResolved: true,
  pushTargets: [], criticalBypassDnd: true,
};

test('THE DEFECT NAMED: configured-but-unreachable is now a distinct state', () => {
  process.env.SUPERVISOR_TOKEN = 'test-token';
  assert.equal(isConfigured(base), true, 'we can dispatch...');
  assert.equal(reachesAPhone(base), false, '...but nothing reaches a phone');
  assert.equal(reachesAPhone({ ...base, pushTargets: ['mobile_app_iphone'] }), true);
  assert.equal(reachesAPhone({ ...base, channel: 'none', pushTargets: ['mobile_app_iphone'] }), false);
});

/* ── the removed channels fail SAFE ───────────────────────────────────────── */

test('a stored ntfy/pushover/webhook value falls back to none, never to a silent pretend-send', () => {
  const prev = process.env.NOTIFY_CHANNEL;
  for (const stale of ['ntfy', 'pushover', 'webhook', 'NTFY']) {
    process.env.NOTIFY_CHANNEL = stale;
    assert.equal(loadNotifyConfig().channel, 'none', `${stale} must not be treated as configured`);
  }
  process.env.NOTIFY_CHANNEL = 'ha';
  assert.equal(loadNotifyConfig().channel, 'ha');
  if (prev === undefined) delete process.env.NOTIFY_CHANNEL; else process.env.NOTIFY_CHANNEL = prev;
});

test('the critical bypass defaults ON and is disabled only by an explicit 0', () => {
  const prev = process.env.NOTIFY_CRITICAL_BYPASS_DND;
  delete process.env.NOTIFY_CRITICAL_BYPASS_DND;
  assert.equal(loadNotifyConfig().criticalBypassDnd, true, 'life-safety default');
  process.env.NOTIFY_CRITICAL_BYPASS_DND = '0';
  assert.equal(loadNotifyConfig().criticalBypassDnd, false);
  if (prev === undefined) delete process.env.NOTIFY_CRITICAL_BYPASS_DND; else process.env.NOTIFY_CRITICAL_BYPASS_DND = prev;
});

/* ── the removed stack is really gone ─────────────────────────────────────── */

test('no ntfy / pushover / webhook transport survives in the source', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/notify.ts'), 'utf8');
  for (const dead of ['ntfy.sh', 'api.pushover.net', 'webhookUrl', 'NTFY_PRIORITY', 'PUSHOVER_PRIORITY']) {
    assert.ok(!src.includes(dead), `${dead} must be gone, not merely unreferenced`);
  }
});

test('the add-on schema, defaults and translations agree exactly', () => {
  // A translation key that does not byte-match a schema key silently loses its
  // label in the config UI; a stored option with no schema entry blocks startup.
  const root = resolve(import.meta.dirname, '../../ecoflow_panel');
  const cfg = readFileSync(resolve(root, 'config.yaml'), 'utf8');
  const tr = readFileSync(resolve(root, 'translations/en.yaml'), 'utf8');
  for (const dead of ['NOTIFY_NTFY_SERVER', 'NOTIFY_NTFY_TOPIC', 'NOTIFY_PUSHOVER_TOKEN',
    'NOTIFY_PUSHOVER_USER', 'NOTIFY_WEBHOOK_URL']) {
    assert.ok(!cfg.includes(dead), `${dead} still in config.yaml`);
    assert.ok(!tr.includes(dead), `${dead} still in translations`);
  }
  for (const added of ['NOTIFY_HA_PUSH_TARGETS', 'NOTIFY_CRITICAL_BYPASS_DND']) {
    assert.ok(cfg.includes(added) && tr.includes(added), `${added} must be in both`);
  }
  assert.ok(cfg.includes('NOTIFY_CHANNEL: list(none|ha)'), 'the channel list must be narrowed');
});
