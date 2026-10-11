/**
 * v1.187.15 — the AppArmor profile's invariants, pinned so a later edit cannot silently undo
 * the 2026-10-11 review or reintroduce the two outages it recorded (DOCS "AppArmor profile").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../ecoflow_panel/apparmor.txt'), 'utf8');
const rules = PROFILE.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

test('★★★ the blanket `file,` rule stays (v1.7.0: a per-path list crash-looped s6 /init)', () => {
  assert.ok(rules.includes('file,'));
});

test('★★★ no rule combines the append and write bits (v1.9.0: `wal` failed to load on the HAOS parser)', () => {
  for (const r of rules.filter((x) => /^(?:(?:audit\s+)?deny\s+|owner\s+)?\//.test(x))) {
    const m = /\s([a-z]+),$/.exec(r);
    if (m && /^[rwalkmix]+$/.test(m[1])) assert.ok(!(m[1].includes('a') && m[1].includes('w')), `a and w together: ${r}`);
  }
});

test('★★ the capability allow list is exactly chown and dac_override', () => {
  const allowed = rules.filter((r) => /^capability /.test(r)).map((r) => r.replace(/^capability\s+|,$/g, '')).sort();
  assert.deepEqual(allowed, ['chown', 'dac_override']);
  assert.ok(rules.includes('deny capability sys_admin,') && rules.includes('deny capability sys_ptrace,'));
});

test('★★ network is the families in use — no blanket rule, no raw or packet sockets', () => {
  assert.ok(!rules.includes('network,'), 'no blanket network rule');
  const net = rules.filter((r) => /^network /.test(r));
  assert.deepEqual(net.sort(), ['network inet dgram,', 'network inet stream,', 'network inet6 dgram,', 'network inet6 stream,', 'network netlink raw,', 'network unix,'].sort());
});

test('★★ the code, system and config directories are write-locked', () => {
  for (const d of ['/app', '/usr', '/bin', '/sbin', '/lib', '/etc', '/package', '/command']) {
    assert.ok(rules.includes(`deny ${d}/{,**} wl,`), `write-lock on ${d}`);
  }
  assert.ok(rules.includes('deny /init wl,'));
});
