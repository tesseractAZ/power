/**
 * v1.187.10 (log review 10-03, C32) — per-request logging stays off, through the option Fastify
 * supports.
 *
 * index.ts passed the top-level `disableRequestLogging: true`, which Fastify 5.12 deprecates: each
 * boot wrote a non-JSON "(node) [FSTDEP023] FastifyDeprecation: disableRequestLogging option is
 * deprecated … will be removed in fastify@6" line. The option is what keeps 'incoming request' and
 * 'request completed' (78 % of journald volume when on, v0.15.18) out of the log, and no test
 * pinned that. Here the server is built with index.ts's own options (panelFastifyOptions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { panelFastifyOptions } from '../src/logHooks.js';

test('★★★ a 200 and a 404 write no per-request log lines, and building the server raises no Fastify deprecation', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error & { code?: string }) => warnings.push(`${w.code ?? ''} ${w.name}: ${w.message}`);
  process.on('warning', onWarning);
  const lines: string[] = [];
  const app = Fastify(panelFastifyOptions('debug', { write: (m: string) => { lines.push(m); } }));
  app.get('/api/version', async () => ({ version: 'test' }));
  try {
    const ok = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(ok.statusCode, 200);
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(missing.statusCode, 404);
    await new Promise((r) => setImmediate(r)); // let process warnings be delivered
    const msgs = lines.map((l) => (JSON.parse(l) as { msg?: string }).msg ?? '');
    assert.ok(!msgs.some((m) => m === 'incoming request' || m === 'request completed'), `request logging is off at level debug:\n${msgs.join('\n')}`);
    assert.deepEqual(warnings.filter((w) => /FSTDEP|Fastify/i.test(w)), [], 'no FastifyDeprecation (FSTDEP023)');
  } finally {
    process.off('warning', onWarning);
    await app.close();
  }
});

test('control: the same server WITHOUT the controller does log requests (the assertion above can fail)', async () => {
  const lines: string[] = [];
  const { logger } = panelFastifyOptions('debug', { write: (m: string) => { lines.push(m); } });
  const app = Fastify({ logger });
  app.get('/x', async () => 'ok');
  try {
    await app.inject({ method: 'GET', url: '/x' });
    assert.ok(lines.some((l) => l.includes('"msg":"incoming request"')));
  } finally {
    await app.close();
  }
});
