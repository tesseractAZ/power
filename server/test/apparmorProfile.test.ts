/**
 * v1.187.15 — the AppArmor profile's invariants, pinned so a later edit cannot silently undo
 * the 2026-10-11 review or reintroduce the two outages it recorded
 * (docs/reference/12-configuration-deployment-security.md “AppArmor profile”).
 *
 * v1.197.1 — the blanket `file,` rule is gone: reads are granted per top-level folder. A missed
 * read or exec on the s6 / bashio / npm / tsx path is an INVISIBLE init crash-loop with the whole
 * alarm down (v1.7.0), so this file evaluates the profile the way the kernel does: a small
 * AppArmor glob matcher over the profile's own file rules (deny beats allow) checks every path
 * the isolated boot test exercises, by the path the kernel names (the target of a symlink, a
 * folder with its trailing slash).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../ecoflow_panel/apparmor.txt'), 'utf8');
const rules = PROFILE.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

/* ── a small AppArmor file-rule evaluator ──────────────────────────────────────────────────── */

type Perm = 'r' | 'w' | 'a' | 'l' | 'k' | 'm' | 'x';
interface FileRule { text: string; deny: boolean; audit: boolean; globs: string[]; res: RegExp[]; perms: Set<Perm> }

/** `{a,b}` alternation (nested allowed) expanded into one glob per alternative. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { close = i; break; } }
    else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close < 0) throw new Error(`unbalanced braces in ${glob}`);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push(...expandBraces(glob.slice(0, open) + glob.slice(bounds[i] + 1, bounds[i + 1]) + glob.slice(close + 1)));
  }
  return out;
}

/**
 * One brace-free AppArmor glob as an anchored RegExp. `*` is any run of characters but `/`,
 * `**` any run including `/`, `?` one character but `/`, `[..]` a class. A `*` or `**` that
 * STARTS a path element must match at least one character, and not a `/` (the parser's rule:
 * `/data/**` does not match `/data/`, which is why a folder's own listing needs `/data/{,**}`).
 */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const startsElement = i === 0 || glob[i - 1] === '/';
    if (c === '*') {
      if (glob[i + 1] === '*') { re += startsElement ? '[^/].*' : '.*'; i++; }
      else re += startsElement ? '[^/]+' : '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) throw new Error(`unbalanced [ in ${glob}`);
      re += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|\\{}]/g, '\\$&');
    }
  }
  return new RegExp(`${re}$`);
}

/** Permission letters → the set they grant or deny. `w` covers append; an exec mode (`ix`, `px`, …) or a bare `x` is `x`. */
function permSet(mask: string): Set<Perm> {
  const out = new Set<Perm>();
  for (const ch of mask.replace(/[iupcIUPC]x/g, 'x')) {
    if (ch === 'w') { out.add('w'); out.add('a'); } else if ('ralkmx'.includes(ch)) out.add(ch as Perm);
    else throw new Error(`unknown permission letter ${ch} in ${mask}`);
  }
  return out;
}

const FILE_RULE = /^(audit\s+)?(deny\s+)?(?:owner\s+)?(\/\S*)\s+([a-zA-Z]+),$/;
const fileRules: FileRule[] = rules.flatMap((text): FileRule[] => {
  if (text === 'file,') {
    return [{ text, deny: false, audit: false, globs: ['/{,**}'], res: [/^\/.*$/], perms: permSet('rwlkmix') }];
  }
  if (!/^(?:audit\s+)?(?:deny\s+)?(?:owner\s+)?\//.test(text)) return [];
  const m = FILE_RULE.exec(text);
  if (!m) throw new Error(`unparseable file rule: ${text}`);
  const globs = expandBraces(m[3]);
  return [{ text, deny: !!m[2], audit: !!m[1], globs, res: globs.map(globToRegExp), perms: permSet(m[4]) }];
});

/** 'allow' — an allow rule grants `perm` and no deny rule refuses it; 'deny' — a deny rule refuses it
 *  (deny always wins); 'none' — nothing grants it (refused, and logged as DENIED in enforce mode). */
function decide(path: string, perm: Perm): 'allow' | 'deny' | 'none' {
  const hits = fileRules.filter((r) => r.perms.has(perm) && r.res.some((re) => re.test(path)));
  if (hits.some((r) => r.deny)) return 'deny';
  return hits.length ? 'allow' : 'none';
}
const denyingRules = (path: string, perm: Perm) => fileRules.filter((r) => r.deny && r.perms.has(perm) && r.res.some((re) => re.test(path)));
const granted = (path: string, perms: string) => [...permSet(perms)].every((p) => decide(path, p) === 'allow');

/* ── the tests ─────────────────────────────────────────────────────────────────────────────── */

test('the evaluator reads globs the way the parser does (a `*` / `**` starting an element is never empty)', () => {
  assert.deepEqual(expandBraces('/{a,b}/{,**}'), ['/a/', '/a/**', '/b/', '/b/**']);
  assert.deepEqual(expandBraces('/proc/*/{,task/*/}mem'), ['/proc/*/mem', '/proc/*/task/*/mem']);
  const all = globToRegExp('/data/**');
  assert.ok(all.test('/data/x') && all.test('/data/a/b/') && !all.test('/data/') && !all.test('/data'));
  const one = globToRegExp('/data/*');
  assert.ok(one.test('/data/x') && !one.test('/data/a/b') && !one.test('/data/'));
  const pid = globToRegExp('/proc/[0-9]*/comm');
  assert.ok(pid.test('/proc/1/comm') && pid.test('/proc/123/comm') && !pid.test('/proc/self/comm'));
  assert.ok(globToRegExp('/run/s6-rc**').test('/run/s6-rc:s6-rc-init:ab/servicedirs/x/run'));
  assert.ok(fileRules.length > 50, `parsed ${fileRules.length} file rules`);
});

test('★★★ no blanket file rule; /init and the s6 trees stay readable and executable (v1.7.0: a per-path list without `/init r` crash-looped s6)', () => {
  assert.ok(!rules.includes('file,'), 'the blanket `file,` rule is gone (v1.197.1)');
  for (const r of [
    '/init r,',
    '/init ix,',
    '/{bin,sbin,lib,lib64,usr,package,command}/{,**} rm,',
    '/etc/{,**} r,',
    '/var/{,**} r,',
    '/app/{,**} r,',
    '/package/** ix,',
    '/command/** rwix,',
    '/run/s6/** rwix,',
    '/run/s6-rc** rwix,',
    '/run/service/** ix,',
  ]) {
    assert.ok(rules.includes(r), `missing: ${r}`);
  }
  // Every program folder of the image stays readable as a whole, for every file in it.
  for (const p of ['/bin/busybox', '/sbin/x', '/lib/ld-musl-aarch64.so.1', '/usr/lib/bashio/bashio.sh', '/package/admin/s6-overlay/libexec/stage0', '/command/with-contenv', '/etc/s6-overlay/s6-rc.d/user/type', '/app/server/package.json', '/var/lib/apk/x']) {
    assert.equal(decide(p, 'r'), 'allow', `read of ${p}`);
  }
});

/** The boot-test inventory: every path the isolated boot test exercises, by the path AppArmor
 *  checks (a symlink's TARGET; a folder with its trailing slash), with the result it must get. */
const GRANTED: ReadonlyArray<readonly [path: string, perms: string, why: string]> = [
  // s6-overlay: the kernel starts /init (/bin/sh), sh reads it; s6 runs its packages and the scripts it copies into /run
  ['/init', 'rx', 'v1.7.0: sh opens /init for reading'],
  ['/bin/busybox', 'rx', '/bin/sh and every busybox applet'],
  ['/package/admin/s6-overlay-helpers/command/s6-overlay-suexec', 'rx', 's6-overlay stage 0'],
  ['/package/admin/s6-2.13.1.0/command/s6-svscan', 'rmx', '/command/s6-svscan resolves into a versioned package folder'],
  ['/package/admin/execline-2.9.6.1/command/execlineb', 'rx', 'with-contenv is an execline script'],
  ['/package/admin/s6-overlay/etc/s6-linux-init/current/scripts/rc.init', 'rx', 's6-linux-init stage 2'],
  ['/run/service/.s6-svscan/finish', 'rx', 'scandir copy in /run: the stop path'],
  ['/run/service/s6-linux-init-shutdownd/run', 'rx', 'scandir copy in /run: the shutdown daemon'],
  ['/run/service/ecoflow-panel/supervise/control', 'rw', 's6-supervise control fifo'],
  ['/run/s6-rc:s6-rc-init:abcd/servicedirs/s6rc-oneshot-runner/run', 'rx', 's6-rc live service directory'],
  ['/run/s6/legacy-services/ecoflow-panel/run', 'rx', 'the services.d run script, copied by services-up'],
  ['/run/s6/container_environment/TZ', 'rw', 'with-contenv'],
  ['/run/', 'r', "s6's runtime folder itself"],
  ['/etc/s6-overlay/s6-rc.d/user/contents.d/legacy-services', 'r', 's6-rc source'],
  // the run script: bashio (/usr/bin/bashio is a symlink), bash via env, jq on the options
  ['/usr/lib/bashio/bashio', 'rx', '`#!/usr/bin/with-contenv bashio`'],
  ['/usr/lib/bashio/bashio.sh', 'r', 'sourced by bashio'],
  ['/bin/bash', 'rx', "bashio's interpreter"],
  ['/usr/bin/jq', 'rx', 'bashio::config'],
  ['/data/options.json', 'r', 'every option'],
  ['/tmp/.bashio/addon.config.cache', 'rw', "bashio's cache"],
  // npm start → sh → tsx → node → esbuild
  ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'rx', '`exec npm start` (/usr/bin/npm is a symlink)'],
  ['/usr/lib/node_modules/npm/lib/npm.js', 'r', 'npm itself'],
  ['/usr/bin/node', 'rx', 'node'],
  ['/usr/lib/libstdc++.so.6.0.33', 'rm', "node's shared libraries"],
  ['/lib/ld-musl-aarch64.so.1', 'rm', 'the dynamic loader'],
  ['/app/server/node_modules/tsx/dist/cli.mjs', 'rx', 'node_modules/.bin/tsx'],
  ['/app/server/node_modules/tsx/dist/loader.mjs', 'r', "tsx's loader"],
  ['/app/server/node_modules/@esbuild/linux-arm64/bin/esbuild', 'x', 'esbuild service (aarch64)'],
  ['/app/server/node_modules/@esbuild/linux-x64/bin/esbuild', 'x', 'esbuild service (amd64)'],
  ['/tmp/tsx-0/', 'rw', "tsx's cache folder"],
  ['/tmp/tsx-0/1234.pipe', 'rw', "tsx's IPC socket"],
  // node's runtime
  ['/usr/share/icu/74.2/icudt74l.dat', 'r', 'ICU data'],
  ['/usr/share/zoneinfo/America/Phoenix', 'r', 'tzdata'],
  ['/etc/ssl/openssl.cnf', 'r', 'OpenSSL'],
  ['/etc/ssl/certs/ca-certificates.crt', 'r', 'CA bundle'],
  ['/etc/resolv.conf', 'r', 'DNS'],
  ['/proc/123/cgroup', 'r', 'libuv constrained memory'],
  ['/proc/123/task/456/comm', 'rw', "musl's pthread_setname_np"],
  ['/proc/123/comm', 'rw', 'process name'],
  ['/proc/loadavg', 'r', 'selfVitals'],
  ['/proc/meminfo', 'r', 'selfVitals'],
  ['/proc/stat', 'r', 'os.cpus'],
  ['/sys/fs/cgroup/memory.max', 'r', 'libuv constrained memory'],
  ['/sys/fs/cgroup/cpu.max', 'r', 'libuv available parallelism'],
  ['/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'r', 'os.cpus'],
  ['/sys/class/thermal/', 'r', 'hostThermal lists the zones'],
  ['/sys/devices/virtual/thermal/thermal_zone0/temp', 'r', 'thermal_zone0 is a symlink into /sys/devices'],
  ['/dev/null', 'rw', 'stdio'],
  ['/dev/urandom', 'r', 'crypto'],
  // the server: /data, the static UI, the workers
  ['/data/', 'r', 'atomicWrite.ts lists /data; SQLite fsyncs the folder'],
  ['/data/ecoflow.db', 'rwk', 'the database'],
  ['/data/ecoflow.db-wal', 'rwk', 'WAL'],
  ['/data/ecoflow.db-shm', 'rwk', 'WAL index'],
  ['/data/maintenance-windows.json', 'rw', 'v1.197.0 maintenance windows'],
  ['/data/ssh_host_ed25519_key', 'rw', 'SSH console host key'],
  ['/data/panel-write-token.txt', 'rw', 'write token (chmod needs w)'],
  ['/data/audio/', 'r', 'static audio root'],
  ['/data/audio/klaxon.wav', 'rw', 'rendered audio'],
  ['/data/.clean-shutdown', 'rw', 'clean-shutdown marker'],
  ['/app/web/dist/', 'r', '@fastify/static lists the UI'],
  ['/app/web/dist/index.html', 'r', 'the UI'],
  ['/app/server/src/analyticsWorkerBootstrap.mjs', 'r', 'worker URL'],
  ['/app/server/src/dbExportWorkerBootstrap.mjs', 'r', 'worker URL'],
  ['/app/server/node_modules/@xterm/xterm/lib/xterm.js', 'r', 'the /console page'],
  ['/var/tmp/etilqs_abc', 'rw', 'SQLite temp file (VACUUM INTO)'],
  // the database snapshot and the backup hook (docker exec, this profile)
  ['/share/', 'r', 'the listing of /share'],
  ['/share/ecoflow-panel/', 'rw', 'mkdir -p'],
  ['/share/ecoflow-panel/backup-window.jsonl', 'rw', 'backup journal'],
  ['/share/ecoflow-panel/.ecoflow-snapshot.db.tmp', 'rwk', 'VACUUM INTO temp'],
  ['/share/ecoflow-panel/ecoflow-snapshot.db', 'rw', 'published snapshot'],
  ['/usr/bin/ecoflow-panel-backup-hook', 'rx', 'config.yaml backup_pre / backup_post'],
  ['/app/server/src/backupHook.mjs', 'r', 'the hook client'],
];

const REFUSED: ReadonlyArray<readonly [path: string, perm: Perm, by: 'audit-deny' | 'deny' | 'none', why: string]> = [
  // other add-ons' files under /share: nothing grants them (enforce logs DENIED)
  ['/share/switchboard/x', 'r', 'none', "another add-on's file"],
  ['/share/switchboard/x', 'w', 'none', "another add-on's file"],
  ['/share/decoy/x', 'r', 'none', 'the boot-test probe'],
  // nothing runs from a writable tree — an explicit, logged deny, so no later allow can grant it
  ['/data/x', 'x', 'audit-deny', 'exec from /data'],
  ['/data/x', 'm', 'audit-deny', 'exec-map from /data'],
  ['/share/ecoflow-panel/x', 'x', 'audit-deny', 'exec from /share'],
  ['/tmp/tsx-0/x', 'x', 'audit-deny', 'exec from /tmp'],
  ['/tmp/x.so', 'm', 'audit-deny', 'exec-map from /tmp'],
  ['/var/tmp/x', 'x', 'audit-deny', 'exec from /var/tmp'],
  // a process's memory file
  ['/proc/123/mem', 'w', 'audit-deny', '/proc/self/mem resolves to /proc/<pid>/mem'],
  ['/proc/123/task/456/mem', 'w', 'audit-deny', 'a thread memory file'],
  ['/proc/self/mem', 'w', 'audit-deny', 'the unresolved name, too'],
  // Home Assistant folders this add-on does not map: an audited tripwire
  ['/config/configuration.yaml', 'r', 'audit-deny', 'HA configuration'],
  ['/config/', 'r', 'audit-deny', 'HA configuration folder'],
  ['/ssl/privkey.pem', 'r', 'audit-deny', 'TLS keys'],
  ['/backup/x.tar', 'r', 'audit-deny', 'backups'],
  ['/addons/x', 'r', 'audit-deny', 'local add-ons'],
  ['/addon_configs/x', 'w', 'audit-deny', 'add-on configs'],
  ['/homeassistant/secrets.yaml', 'r', 'audit-deny', 'HA configuration (new name)'],
  ['/media/x', 'r', 'audit-deny', 'media'],
  // the secrets and the write-locks that predate v1.197.1 (plain denies)
  ['/etc/shadow', 'r', 'deny', 'password hashes'],
  ['/etc/ssh/ssh_host_ed25519_key', 'r', 'deny', 'host keys'],
  ['/root/.npm/_logs/x.log', 'w', 'deny', "npm's log (silent on purpose)"],
  ['/app/server/src/index.ts', 'w', 'deny', 'code write-lock'],
  ['/usr/bin/node', 'w', 'deny', 'binary write-lock'],
  ['/init', 'w', 'deny', 'init write-lock'],
  ['/etc/passwd', 'w', 'deny', 'config write-lock'],
  ['/package/admin/s6/command/s6-svscan', 'w', 'deny', 's6 write-lock'],
  ['/proc/sys/kernel/x', 'w', 'deny', 'kernel tunables'],
  ['/sys/kernel/x', 'w', 'deny', 'kernel tunables'],
  // and anything outside the granted folders
  ['/mnt/x', 'r', 'none', 'not granted'],
  ['/opt/x', 'x', 'none', 'not granted'],
];

test('★★★ boot-test inventory: every path the isolated boot test exercises gets its expected result (deny beats allow)', () => {
  for (const [path, perms, why] of GRANTED) {
    for (const p of permSet(perms)) {
      assert.equal(decide(path, p), 'allow', `${path} ${p} must be granted (${why})`);
    }
  }
  for (const [path, perm, by, why] of REFUSED) {
    const got = decide(path, perm);
    if (by === 'none') {
      assert.equal(got, 'none', `${path} ${perm} must be refused by default, granted by nothing (${why})`);
    } else {
      assert.equal(got, 'deny', `${path} ${perm} must be refused by an explicit deny (${why})`);
      if (by === 'audit-deny') {
        assert.ok(denyingRules(path, perm).some((r) => r.audit), `${path} ${perm}: the deny must be \`audit deny\` (a plain deny is silent) (${why})`);
      }
    }
  }
});

test('★★★ /data/options.json is never denied for read (bashio reads every option from it)', () => {
  assert.equal(decide('/data/options.json', 'r'), 'allow');
  assert.deepEqual(denyingRules('/data/options.json', 'r').map((r) => r.text), []);
  // No deny rule that could reach /data carries a read bit at all.
  for (const r of fileRules.filter((x) => x.deny && x.globs.some((g) => /^\/(?:\*|data)/.test(g)))) {
    assert.ok(!r.perms.has('r'), `a read deny that can reach /data: ${r.text}`);
  }
});

test("★★ /share is the add-on's own folder only", () => {
  const share = fileRules.filter((r) => !r.deny && r.globs.some((g) => g.startsWith('/share')));
  assert.ok(share.length >= 2);
  for (const r of share) {
    assert.ok(r.text === '/share/ r,' || r.text.startsWith('/share/ecoflow-panel/'), `a /share grant beyond the add-on's folder: ${r.text}`);
  }
  assert.ok(!granted('/share/other-addon/', 'r'), "another add-on's folder listing");
});

test('★★ npm start → sh → tsx → node → esbuild can exec, by the paths the kernel checks', () => {
  for (const [path, perms] of [
    ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'rx'],
    ['/bin/busybox', 'rx'],
    ['/app/server/node_modules/tsx/dist/cli.mjs', 'rx'],
    ['/usr/bin/node', 'rmx'],
    ['/app/server/node_modules/@esbuild/linux-arm64/bin/esbuild', 'rx'],
    ['/app/server/node_modules/@esbuild/linux-x64/bin/esbuild', 'rx'],
    ['/app/server/node_modules/esbuild/bin/esbuild', 'rx'],
    ['/usr/lib/bashio/bashio', 'rx'],
  ] as const) {
    assert.ok(granted(path, perms), `${path} needs ${perms}`);
  }
});

test('★★ no exec from writable trees, no /proc mem write — each an explicit audited deny', () => {
  // Structural: no allow rule grants x or m on a writable tree.
  for (const r of fileRules.filter((x) => !x.deny)) {
    if (r.globs.some((g) => /^\/(?:data|share|tmp|var\/tmp)(?:\/|$)/.test(g))) {
      assert.ok(!r.perms.has('x') && !r.perms.has('m'), `exec on a writable tree: ${r.text}`);
    }
  }
  // Semantic: an audited deny refuses them, so an allow rule added later cannot grant them.
  for (const p of ['/data/x', '/data/sub/x', '/share/ecoflow-panel/x', '/share/other/x', '/tmp/x', '/var/tmp/x']) {
    for (const perm of ['x', 'm'] as const) {
      assert.ok(denyingRules(p, perm).some((r) => r.audit), `${p} ${perm} needs an audit deny`);
    }
  }
  for (const p of ['/proc/1/mem', '/proc/self/mem', '/proc/1/task/2/mem']) {
    assert.ok(denyingRules(p, 'w').some((r) => r.audit), `${p} w needs an audit deny`);
    assert.ok(denyingRules(p, 'a').some((r) => r.audit), `${p} append needs an audit deny`);
  }
});

test('★★ every deny added since v1.197.1 is `audit deny`; the /root and /home denies stay plain (npm noise)', () => {
  for (const r of [
    'audit deny /{config,ssl,backup,media,addons,addon_configs,homeassistant}/{,**} rwlkmx,',
    'audit deny /{data,share,tmp,var/tmp}/** mx,',
    'audit deny /proc/*/{,task/*/}mem w,',
  ]) {
    assert.ok(rules.includes(r), `missing: ${r}`);
  }
  assert.ok(rules.includes('deny /root/** rw,') && rules.includes('deny /home/** rw,'));
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

test('★★ v1.187.20 — the backup hook can run under this profile (docker exec runs it confined by it)', () => {
  // config.yaml backup_pre / backup_post → /usr/bin/ecoflow-panel-backup-hook (sh) → /usr/bin/node →
  // TCP to 127.0.0.1:8787, appending to /share/ecoflow-panel or /data. A rule this needs, removed,
  // fails at BACKUP time: the hook exits non-zero or hangs and the add-on drops out of the backup.
  for (const r of ['/usr/bin/** ix,', '/bin/** ix,', 'network inet stream,', 'network inet6 stream,']) {
    assert.ok(rules.includes(r), `the hook needs: ${r}`);
  }
  for (const [path, perms] of [
    ['/usr/bin/ecoflow-panel-backup-hook', 'rx'],
    ['/bin/busybox', 'rx'],
    ['/usr/bin/node', 'rx'],
    ['/app/server/src/backupHook.mjs', 'r'],
    ['/share/ecoflow-panel/', 'rw'],
    ['/share/ecoflow-panel/backup-window.jsonl', 'rwa'],
    ['/data/backup-window.jsonl', 'rwa'],
  ] as const) {
    assert.ok(granted(path, perms), `the hook needs ${perms} on ${path}`);
  }
  // A deny that reaches /data or /share may refuse exec or exec-mapping there, never a read or a write.
  for (const r of fileRules.filter((x) => x.deny && x.globs.some((g) => /^\/(?:share|data)(?:\/|$)/.test(g)))) {
    assert.ok([...r.perms].every((p) => p === 'm' || p === 'x'), `a deny on the journal locations refuses more than exec: ${r.text}`);
  }
});
