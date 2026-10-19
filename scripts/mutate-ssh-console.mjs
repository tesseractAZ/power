#!/usr/bin/env node
/**
 * mutate-ssh-console.mjs — v1.190.0: the LAN console is served over SSH (telnet until 1.189.x).
 * Password-only logins against TUI_USERNAME / TUI_PASSWORD, refuse-all without a password, the
 * login card's budgets reused at the protocol level, the host key generated once and kept, the
 * connection caps and reclaim on our own net server, the login card skipped for SSH sessions,
 * and the TELNET_ENABLED / TELNET_PORT aliases resolved in config.ts.
 *
 *   A-i     no console password admits the connection (the refuse-all gate accepts)
 *   A-ii    the no-password refusal is logged on every attempt, not once per connection
 *   A-iii   the `none` method is accepted (a client without a password logs in)
 *   A-iv    the cross-session throttle is ignored
 *   A-v     every password verifies
 *   A-vi    a failed login is not counted against the cross-session window
 *   A-vii   the per-connection attempt budget is 300, not 3
 *   S-i     exec is accepted (the port runs commands)
 *   S-ii    the sftp subsystem is accepted
 *   S-iii   a window change is ignored (the frame keeps the pty's width)
 *   S-iv    the pty's size is ignored (every session is 80×24)
 *   S-v     the SSH session is constructed WITHOUT preAuthenticated (the login card is drawn over SSH)
 *   S-vi    the session driver ignores preAuthenticated (the card is drawn whatever the transport says)
 *   S-vii   verifyConsoleCredentials checks the password only
 *   S-viii  describeSshAuth claims password login with no password set
 *   K-i     the host key is regenerated at every start (clients see a changed key)
 *   K-ii    the host key is written world-readable
 *   C-i     the global connection cap is 100 higher
 *   C-ii    the per-address cap is 100 higher
 *   C-iii   the idle sweep never reclaims
 *   C-iv    inbound bytes do not refresh the idle clock (an active operator is reaped)
 *   C-v     the login grace never fires
 *   C-vi    TCP keep-alive is not set
 *   C-vii   the teardown line is not logged
 *   O-i     the enabled aliases combine with AND (TELNET_ENABLED alone no longer turns the console on)
 *   O-ii    SSH_PORT at its default no longer defers to TELNET_PORT
 *   O-iii   the TELNET_PORT deprecation note is dropped
 *   O-iv    the TELNET_ENABLED deprecation note is dropped
 *   O-v     TELNET_PORT overrides a SET SSH_PORT
 *   O-vi    the call site logs no alias notice
 *   O-vii   the fingerprint leaves the startup line
 *   R-i     the run script exports SSH_ENABLED=false (config.ts reads `!== '0'`: off reads as on)
 *   R-ii    the host key path moves out of /data
 *   R-iii   TELNET_PORT is no longer exported (the alias is declared but inert)
 *   Y-i     SSH_PORT's shipped default is not the published port
 *   Y-ii    SSH_ENABLED ships on
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRV = resolve(REPO, 'server/src/telnet/server.ts');
const SESS = resolve(REPO, 'server/src/telnet/session.ts');
const CFG = resolve(REPO, 'server/src/config.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const RUN = resolve(REPO, 'rootfs/etc/services.d/ecoflow-panel/run');
const YAML = resolve(REPO, 'ecoflow_panel/config.yaml');
const SUBSET = [
  'test/sshServer.test.ts',
  'test/sshCaps.test.ts',
  'test/sshConfig.test.ts',
  'test/wsConsole.test.ts',
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
    id: 'A-iv. ★★ the cross-session throttle is ignored',
    file: SRV,
    find: '    if (consoleLoginThrottled(now)) {',
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
    id: 'A-vi. ★★ a failed login is not counted against the cross-session window',
    file: SRV,
    find: '    noteConsoleLoginFailure(now);\n    conn.attempts += 1;',
    to: '    /* MUTANT */\n    conn.attempts += 1;',
    why: 'The browser card and the SSH server share one budget; failures over SSH must spend it.',
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
  /* ── O. the option aliases ── */
  {
    id: 'O-i. ★★★ the enabled aliases combine with AND',
    file: CFG,
    find: '  const enabled = sshOn || telnetOn;',
    to: '  const enabled = sshOn && telnetOn; /* MUTANT */',
    why: 'An install that only ever set TELNET_ENABLED would come up with no LAN console.',
  },
  {
    id: 'O-ii. ★★ SSH_PORT at its default no longer defers to TELNET_PORT',
    file: CFG,
    find: '    port = telnetPort;',
    to: '    /* MUTANT */',
    why: 'An install that moved the port with TELNET_PORT would come up on 2323.',
  },
  {
    id: 'O-iii. ★ the TELNET_PORT deprecation note is dropped',
    file: CFG,
    find: '    deprecationNotes.push(`SSH_PORT is at its default and the deprecated TELNET_PORT is ${telnetPort}: TELNET_PORT applies; set SSH_PORT instead`);',
    to: '    /* MUTANT */',
    why: 'The alias would apply silently.',
  },
  {
    id: 'O-iv. ★ the TELNET_ENABLED deprecation note is dropped',
    file: CFG,
    find: '  if (!sshOn && telnetOn) {\n    deprecationNotes.push(',
    to: '  if (false) { /* MUTANT */\n    deprecationNotes.push(',
    why: 'As O-iii.',
  },
  {
    id: 'O-v. ★★ TELNET_PORT overrides a SET SSH_PORT',
    file: CFG,
    find: '  if (sshPort === SSH_DEFAULT_PORT && telnetPort != null',
    to: '  if (telnetPort != null /* MUTANT */',
    why: 'The new option must win once it is set.',
  },
  {
    id: 'O-vi. ★ the call site logs no alias notice',
    file: IDX,
    find: '    for (const n of config.ssh.deprecationNotes) app.log.warn(`ssh: ${n}`);',
    to: '    /* MUTANT */',
    why: 'The resolver would compute the notes and nothing would print them.',
  },
  {
    id: 'O-vii. ★★ the fingerprint leaves the startup line',
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
  {
    id: 'R-iii. ★★ TELNET_PORT is no longer exported',
    file: RUN,
    find: 'export TELNET_PORT="$(bashio::config \'TELNET_PORT\')"\n',
    to: '# MUTANT\n',
    why: 'The alias would be declared, shown in the UI, stored by the Supervisor, and inert.',
  },
  /* ── Y. the manifest ── */
  {
    id: "Y-i. ★★ SSH_PORT's shipped default is not the published port",
    file: YAML,
    find: '  SSH_PORT: 2323\n  # Deprecated aliases',
    to: '  SSH_PORT: 2222 # MUTANT\n  # Deprecated aliases',
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
