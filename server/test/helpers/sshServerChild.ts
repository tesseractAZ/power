/**
 * Test helper: the real SSH console server (`startSshServer`) in a process of
 * its own. It prints one JSON line with the bound port on stdout, logs to stderr,
 * and serves until it is killed. A test that must observe whether a client's
 * request takes the whole process down (a V8 heap exhaustion is an abort, not an
 * exception a handler could catch) cannot do so in-process.
 *
 * The console credentials are the suite's fixed test values (sshServer.test.ts).
 */
import { startSshServer, generateHostKey } from '../../src/console/server.js';
import { makeRecorderStub } from './recorderStub.js';

process.env.TUI_USERNAME = 'operator';
process.env.TUI_PASSWORD = 'hunter2';

const KEY = generateHostKey().key; // generateHostKey, not ssh2's generator: ssh2 1.17.0 malforms 1 generated key in 256 (v1.191.7).
const snap = { generatedAt: Date.now(), devices: {}, alerts: [] };
const data = {
  provider: {
    store: { get: () => snap } as never,
    recorder: makeRecorderStub(),
    totals: () => null,
    forecast: () => null,
    degradation: () => null,
    serverStartedAt: Date.now() - 60_000,
  },
  stop: () => {},
};

const t = startSshServer({
  store: {} as never,
  recorder: makeRecorderStub(),
  host: '127.0.0.1',
  port: 0,
  hostKey: KEY,
  log: (m) => console.error(m),
  warn: (m) => console.error(`WARN ${m}`),
  data: data as never,
});
t.server.once('listening', () => {
  const a = t.server.address();
  console.log(JSON.stringify({ port: typeof a === 'object' && a ? a.port : 0 }));
});
