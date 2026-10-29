#!/usr/bin/env node
/**
 * mutate-ssh-console.mjs — v1.190.0: the LAN console is served over SSH (telnet until 1.189.x).
 * Password-only logins against TUI_USERNAME / TUI_PASSWORD, refuse-all without a password, the
 * login card's budgets reused at the protocol level under the connection's address, the host key
 * generated once and kept, the connection caps and reclaim on our own net server, the login card
 * skipped for SSH sessions, and the SSH_* options resolved in config.ts (the TELNET_* aliases were removed in v1.191.6).
 *
 *   A-i     no console password admits the connection (the refuse-all gate accepts)
 *   A-ii    the no-password refusal is logged on every attempt, not once per connection
 *   A-iii   the `none` method is accepted (a client without a password logs in)
 *   A-iv    the failed-login window is ignored
 *   A-v     every password verifies
 *   A-vi    a failed login is not counted against the address's window
 *   A-vii   the per-connection attempt budget is 300, not 3
 *   P-i     every address shares one failed-login window (the table key is a constant)
 *   P-ii    an IPv4 peer of a dual-stack listener (::ffff:a.b.c.d) is not the plain address
 *   P-iii   the SSH server does not clear the address's failures on a login
 *   P-iv    the login card does not clear the address's failures on a login
 *   P-v     the login card counts every session under the unknown address
 *   P-vi    the browser console names no peer (every /console session is the unknown address)
 *   P-vii   failures never age out of the window
 *   P-viii  the address table holds 100 more than its bound
 *   S-i     exec is accepted (the port runs commands)
 *   S-ii    the sftp subsystem is accepted
 *   S-iii   a window change is ignored (the frame keeps the pty's width)
 *   S-iv    the pty's size is ignored (every session is 80×24)
 *   S-v     the SSH session is constructed WITHOUT preAuthenticated (the login card is drawn over SSH)
 *   S-vi    the session driver ignores preAuthenticated (the card is drawn whatever the transport says)
 *   S-vii   verifyConsoleCredentials checks the password only
 *   S-viii  describeSshAuth claims password login with no password set
 *   S-ix    the initial width is not clamped (the pty request's cols reach the renderer as they are)
 *   S-x     the initial height is not clamped (2^32-1 rows exhausted the heap and aborted the process)
 *   S-xi    the initial height's ceiling is 100,000 rows (a frame that stalls the event loop for seconds)
 *   K-i     the host key is regenerated at every start (clients see a changed key)
 *   K-ii    the host key is written world-readable
 *   C-i     the global connection cap is 100 higher
 *   C-ii    the per-address cap is 100 higher
 *   C-iii   the idle sweep never reclaims
 *   C-iv    inbound bytes do not refresh the idle clock (an active operator is reaped)
 *   C-v     the login grace never fires
 *   C-vi    TCP keep-alive is not set
 *   C-vii   the teardown line is not logged
 *   O-i     a stale TELNET_ENABLED turns the console on again (v1.191.6 removed the aliases)
 *   O-ii    the fingerprint leaves the startup line
 *   R-i     the run script exports SSH_ENABLED=false (config.ts reads `!== '0'`: off reads as on)
 *   R-ii    the host key path moves out of /data
 *   Y-i     SSH_PORT's shipped default is not the published port
 *   Y-ii    SSH_ENABLED ships on
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRV = resolve(REPO, 'server/src/console/server.ts');
const SESS = resolve(REPO, 'server/src/console/session.ts');
const WS = resolve(REPO, 'server/src/console/wsConsole.ts');
const CFG = resolve(REPO, 'server/src/config.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const RUN = resolve(REPO, 'rootfs/etc/services.d/ecoflow-panel/run');
const YAML = resolve(REPO, 'ecoflow_panel/config.yaml');
const SUBSET = [
  'test/sshServer.test.ts',
  'test/sshCaps.test.ts',
  'test/sshConfig.test.ts',
  'test/wsConsole.test.ts',
  'test/consoleLoginThrottle.test.ts',
  'test/optionsEnvBridge.test.ts',
];

const MUTANTS = [
  /* ── A. authentication ── */
  {
    id: 'A-i. ★★★ no console password admits the connection',
    file: SRV,
    find: "      ctx.reject([]);\n      return;\n    }\n    if (ctx.method !== 'password')",
    to: "      ctx.accept(); /* MUTANT */\n      return;\n    }\n    if (ctx.method !== 'password')",
    why: 'An SSH port that admits anyone would only look safer than the telnet port it replaces.',
  },
  {
    id: 'A-ii. ★ the no-password refusal is logged on every attempt',
    file: SRV,
    find: '      if (!conn.gateNoted) {\n        conn.gateNoted = true;',
    to: '      if (!conn.gateNoted) {\n        /* MUTANT */',
    why: 'One line per connection, not one per attempt: a probing client would fill the log.',
  },
  {
    id: 'A-iii. ★★★ the none method is accepted',
    file: SRV,
    find: "    if (ctx.method !== 'password') { ctx.reject(['password']); return; }",
    to: "    if (ctx.method !== 'password') { ctx.accept(); return; } /* MUTANT */",
    why: "The client's first attempt is method none; accepting it is a login with no password.",
  },
  {
    id: 'A-iv. ★★ the failed-login window is ignored',
    file: SRV,
    find: '    if (consoleLoginThrottled(conn.ip, now)) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A reconnect loop gets 3 tries per connection, unlimited connections.',
  },
  {
    id: 'A-v. ★★★ every password verifies',
    file: SRV,
    find: '    if (verifyConsoleCredentials(ctx.username, ctx.password, auth)) {',
    to: '    if (true) { /* MUTANT */',
    why: 'The password is checked here and nowhere else on the SSH path.',
  },
  {
    id: "A-vi. ★★ a failed login is not counted against the address's window",
    file: SRV,
    find: '    noteConsoleLoginFailure(conn.ip, now);\n    conn.attempts += 1;',
    to: '    /* MUTANT */\n    conn.attempts += 1;',
    why: 'The browser card and the SSH server share one budget per address; failures over SSH must spend it.',
  },
  /* ── P. the per-address window (1.190.0; one window for every connection until then) ── */
  {
    id: 'P-i. ★★★ every address shares one failed-login window',
    file: SESS,
    find: "  return peer.startsWith('::ffff:') ? peer.slice('::ffff:'.length) : peer;",
    to: "  return '*'; /* MUTANT */",
    why: "The 1.189.x lockout: ten failures from one LAN host refused the operator's correct password from every other host for the rest of the ten minutes.",
  },
  {
    id: 'P-ii. ★ an IPv4 peer of a dual-stack listener is not the plain address',
    file: SESS,
    find: "  return peer.startsWith('::ffff:') ? peer.slice('::ffff:'.length) : peer;",
    to: '  return peer; /* MUTANT */',
    why: 'One host would hold two windows, one per listener form.',
  },
  {
    id: "P-iii. ★★ the SSH server does not clear the address's failures on a login",
    file: SRV,
    find: '      noteConsoleLoginSuccess(conn.ip);\n',
    to: '      /* MUTANT */\n',
    why: "An operator's own mistyped passwords would add up across the day until the operator's address was refused.",
  },
  {
    id: "P-iv. ★★ the login card does not clear the address's failures on a login",
    file: SESS,
    find: '        noteAuthSuccess(this.peer);\n',
    to: '        /* MUTANT */\n',
    why: 'As P-iii, for the browser console.',
  },
  {
    id: 'P-v. ★★★ the login card counts every session under the unknown address',
    file: SESS,
    find: '    this.peer = opts.peer ?? AUTH_PEER_UNKNOWN;',
    to: '    this.peer = AUTH_PEER_UNKNOWN; /* MUTANT */',
    why: 'The browser console would be one window for every address again.',
  },
  {
    id: 'P-vi. ★★★ the browser console names no peer',
    file: WS,
    find: '      peer: req.socket.remoteAddress,\n',
    to: '      /* MUTANT */\n',
    why: 'As P-v, from the transport side: every /console session would count under the unknown address.',
  },
  {
    id: 'P-vii. ★★ failures never age out of the window',
    file: SESS,
    find: '  const kept = (authFailures.get(key) ?? []).filter((t) => now - t < AUTH_THROTTLE_WINDOW_MS);',
    to: '  const kept = (authFailures.get(key) ?? []).filter(() => true); /* MUTANT */',
    why: 'Ten failures would refuse the address until the add-on restarted, not for ten minutes.',
  },
  {
    id: 'P-viii. ★ the address table holds 100 more than its bound',
    file: SESS,
    find: '  while (authFailures.size > AUTH_THROTTLE_MAX_PEERS) {',
    to: '  while (authFailures.size > AUTH_THROTTLE_MAX_PEERS + 100) { /* MUTANT */',
    why: 'The bound is the only thing between a flood of addresses and an entry per address for the life of the process.',
  },
  {
    id: 'A-vii. ★★ the per-connection attempt budget is 300',
    file: SRV,
    find: '    if (conn.attempts >= AUTH_MAX_ATTEMPTS) {',
    to: '    if (conn.attempts >= AUTH_MAX_ATTEMPTS * 100) { /* MUTANT */',
    why: 'Three attempts per connection, as the login card allows.',
  },
  /* ── S. the session ── */
  {
    id: 'S-i. ★★★ exec is accepted',
    file: SRV,
    find: "    sess.on('exec', (_ok, no) => no?.());",
    to: "    sess.on('exec', (ok, _no) => { ok?.(); }); /* MUTANT */",
    why: 'The port serves the TUI and nothing else.',
  },
  {
    id: 'S-ii. ★★ the sftp subsystem is accepted',
    file: SRV,
    find: "    sess.on('subsystem', (_ok, no) => no?.());",
    to: "    sess.on('subsystem', (ok, _no) => { ok?.(); }); /* MUTANT */",
    why: 'As S-i.',
  },
  {
    id: 'S-iii. ★ a window change is ignored',
    file: SRV,
    find: "      if (conn.session && info.cols && info.rows) {\n        const r = conn.session.feed([{ type: 'naws', w: info.cols, h: info.rows }]);",
    to: '      if (conn.session && info.cols && info.rows) { /* MUTANT */\n        const r = conn.session.feed([]);',
    why: 'The window size comes from the SSH client and must follow resizes.',
  },
  {
    id: "S-iv. ★ the pty's size is ignored",
    file: SRV,
    find: "    sess.on('pty', (ok, _no, info) => { w = info.cols || w; h = info.rows || h; ok?.(); });",
    to: "    sess.on('pty', (ok, _no, _info) => { ok?.(); }); /* MUTANT */",
    why: 'Every session would open at 80×24 whatever the terminal is.',
  },
  {
    id: 'S-v. ★★ the SSH session is constructed without preAuthenticated',
    file: SRV,
    find: '        preAuthenticated: true, // the password was checked above; no login card',
    to: '        preAuthenticated: false, /* MUTANT */',
    why: 'The operator would log in twice: once to SSH, once to the card.',
  },
  {
    id: 'S-vi. ★★ the session driver ignores preAuthenticated',
    file: SESS,
    find: "    this.mode = this.auth && !opts.preAuthenticated ? 'auth' : 'plant';",
    to: "    this.mode = this.auth ? 'auth' : 'plant'; /* MUTANT */",
    why: 'As S-v, from the other side.',
  },
  {
    id: 'S-vii. ★★★ verifyConsoleCredentials checks the password only',
    file: SESS,
    find: '  return userOk && passOk;',
    to: '  return passOk; /* MUTANT */',
    why: 'Both fields must match; the username is half of the credential.',
  },
  {
    id: 'S-viii. ★ describeSshAuth claims password login with no password set',
    file: SESS,
    find: "  return auth ? '(password login as the console user)' : '(every login refused — set TUI_PASSWORD)';",
    to: "  return '(password login as the console user)'; /* MUTANT */",
    why: 'The startup line would tell an install with no password that logins work.',
  },
  {
    id: 'S-ix. ★★ the initial width is not clamped',
    file: SESS,
    find: '    this.width = clamp(opts.width ?? 80, 60, 200);',
    to: '    this.width = opts.width ?? 80; /* MUTANT */',
    why: "The SSH transport passes the client's pty request (cols and rows are 32-bit) into the constructor; a window change was clamped by resize(), the pty request was not.",
  },
  {
    id: 'S-x. ★★★ the initial height is not clamped',
    file: SESS,
    find: '    this.height = clamp(opts.height ?? 24, 16, 80);',
    to: '    this.height = opts.height ?? 24; /* MUTANT */',
    why: 'The renderer allocates a line per row on every 1 Hz frame: 2^32-1 rows from a logged-in client exhausted the heap and aborted the whole add-on process (no exception to catch).',
  },
  {
    id: "S-xi. ★★ the initial height's ceiling is 100,000 rows",
    file: SESS,
    find: '    this.height = clamp(opts.height ?? 24, 16, 80);',
    to: '    this.height = clamp(opts.height ?? 24, 16, 100_000); /* MUTANT */',
    why: 'A height that allocates stalls the shared event loop for seconds on every frame for the life of the session.',
  },
  /* ── K. the host key ── */
  {
    id: 'K-i. ★★ the host key is regenerated at every start',
    file: SRV,
    find: '  if (existsSync(path)) {\n    try {\n      const key = readFileSync(path, \'utf8\');',
    to: '  if (false) { /* MUTANT */\n    try {\n      const key = readFileSync(path, \'utf8\');',
    why: 'Every restart would make ssh warn that the host key changed, and the fingerprint in the log would be worthless.',
  },
  {
    id: 'K-ii. ★ the host key is written world-readable',
    file: SRV,
    find: '  writeFileSync(tmp, key, { mode: 0o600 });',
    to: '  writeFileSync(tmp, key); /* MUTANT */',
    why: 'A private key readable by every process in the container.',
  },
  {
    id: 'K-iii. ★★ a generated host key that does not parse back is not regenerated',
    file: SRV,
    find: '      if (attempt >= HOST_KEY_ATTEMPTS) throw e;',
    to: '      throw e; /* MUTANT */',
    why: 'ssh2 1.17.0 malforms 1 generated key in 256; without the retry that start of the SSH console fails.',
  },
  /* ── C. caps and reclaim ── */
  {
    id: 'C-i. ★ the global connection cap is 100 higher',
    file: SRV,
    find: '    if (conns.size >= maxConns) {',
    to: '    if (conns.size >= maxConns + 100) { /* MUTANT */',
    why: 'A LAN flood would get unbounded per-connection render timers (CWE-400).',
  },
  {
    id: 'C-ii. ★ the per-address cap is 100 higher',
    file: SRV,
    find: '    if (sameIp >= maxConnsPerIp) {',
    to: '    if (sameIp >= maxConnsPerIp + 100) { /* MUTANT */',
    why: 'One host could take every slot.',
  },
  {
    id: 'C-iii. ★★ the idle sweep never reclaims',
    file: SRV,
    find: '      if (now - conn.lastRxAt < idleMs) continue;',
    to: '      if (now - conn.lastRxAt < idleMs || true) continue; /* MUTANT */',
    why: 'Abandoned connections would hold their slots and timers forever.',
  },
  {
    id: 'C-iv. ★★ inbound bytes do not refresh the idle clock',
    file: SRV,
    find: "    socket.on('data', () => { conn.lastRxAt = Date.now(); });",
    to: "    socket.on('data', () => { /* MUTANT */ });",
    why: 'An operator typing at the console would be reaped as idle.',
  },
  {
    id: 'C-v. ★★ the login grace never fires',
    file: SRV,
    find: '      if (!conn.authenticated && now - conn.openedAt >= authGraceMs) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A client sending keep-alives could park at the password prompt indefinitely.',
  },
  {
    id: 'C-vi. ★ TCP keep-alive is not set',
    file: SRV,
    find: '    socket.setKeepAlive(true, keepAliveMs);',
    to: '    /* MUTANT */',
    why: 'Half-open peers never send a FIN.',
  },
  {
    id: 'C-vii. ★ the teardown line is not logged',
    file: SRV,
    find: '    log(`ssh: client ${conn.ip} disconnected after ${fmtElapsed(Date.now() - conn.openedAt)} (${conns.size} active)`);',
    to: '    /* MUTANT */',
    why: 'A log review could not pair connects with disconnects.',
  },
  /* ── O. the options (v1.191.6: SSH_* only) ── */
  {
    id: 'O-i. ★★ a stale TELNET_ENABLED turns the console on again',
    file: CFG,
    find: "    enabled: env.SSH_ENABLED !== '0',",
    to: "    enabled: env.SSH_ENABLED !== '0' || env.TELNET_ENABLED === '1', /* MUTANT */",
    why: 'An install still carrying the removed option would serve the console with SSH_ENABLED off.',
  },
  {
    id: 'O-ii. ★★ the fingerprint leaves the startup line',
    file: IDX,
    find: '${describeSshAuth(authFromEnv())} — host key ${hostKey.fingerprint}`);',
    to: '${describeSshAuth(authFromEnv())}`); /* MUTANT */',
    why: 'The operator could not compare what ssh shows on the first connection with anything.',
  },
  /* ── R. the options→env bridge ── */
  {
    id: 'R-i. ★★ the run script exports SSH_ENABLED=false',
    file: RUN,
    find: '  export SSH_ENABLED=0\n',
    to: '  export SSH_ENABLED=false # MUTANT\n',
    why: "config.ts reads `!== '0'`: the string false reads as ON, and the console would be served with the option off.",
  },
  {
    id: 'R-ii. ★ the host key path moves out of /data',
    file: RUN,
    find: 'export SSH_HOST_KEY=/data/ssh_host_ed25519_key\n',
    to: 'export SSH_HOST_KEY=/tmp/ssh_host_ed25519_key # MUTANT\n',
    why: 'The key would not survive a restart; every restart would make ssh warn that it changed.',
  },
  /* ── Y. the manifest ── */
  {
    id: "Y-i. ★★ SSH_PORT's shipped default is not the published port",
    file: YAML,
    find: '  SSH_PORT: 2323\n  TUI_USERNAME: ""',
    to: '  SSH_PORT: 2222 # MUTANT\n  TUI_USERNAME: ""',
    why: 'The published mapping 2323/tcp would point at nothing.',
  },
  {
    id: 'Y-ii. ★★ SSH_ENABLED ships on',
    file: YAML,
    find: '  SSH_ENABLED: false\n  SSH_PORT: 2323',
    to: '  SSH_ENABLED: true # MUTANT\n  SSH_PORT: 2323',
    why: 'A control plane on the host LAN is not on by default on a fresh install (CWE-1188).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-ssh-console', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
