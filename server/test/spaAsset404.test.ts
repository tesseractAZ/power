/**
 * v0.54.0 — asset-prefix hard-404 vs SPA catch-all.
 *
 * The production server (src/index.ts) serves the built web UI with an SPA
 * fallback: any unmatched GET returns index.html so client-side routing works
 * on deep links. The bug: a GET for a MISSING audio asset — e.g. a tone that was
 * deleted or reassigned in the Alert Console — also fell through to that
 * catch-all and returned index.html with HTTP 200. The browser preview then
 * tried to decode HTML as a WAV and failed obscurely, masking a broken
 * assignment as a "success".
 *
 * Fix: GETs under the asset prefixes (/chimes/, /audio-render/, /audio/) must
 * hard-404 instead of falling through to the SPA index.html.
 *
 * This test reproduces the EXACT static-plugin + notFound wiring from index.ts
 * (the handler is inline there and the module self-boots `app.listen`, so it
 * can't be imported) and injects against it — same approach as auth.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

const root = mkdtempSync(resolve(tmpdir(), 'panel-spa404-test-'));

/** Build a Fastify app wired exactly like index.ts: web-dist SPA root + the
 *  three runtime asset statics + the production notFound handler verbatim. */
async function buildApp() {
  const webDist = join(root, 'web');
  const audioDir = join(root, 'audio');
  const audioRenderDir = join(root, 'audio-render');
  const chimesDir = join(root, 'chimes');
  for (const d of [webDist, audioDir, audioRenderDir, chimesDir]) mkdirSync(d, { recursive: true });
  // A recognisable SPA shell so we can tell index.html apart from a 404 body.
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Power SPA</title>');
  // A REAL asset under each prefix, to prove the hard-404 fix does NOT break
  // serving existing files. The /audio/ static is wildcard:false (enumerates at
  // registration), so these must exist before the static plugins register below.
  for (const d of [audioDir, audioRenderDir, chimesDir]) writeFileSync(join(d, 'existing.wav'), 'RIFFEXISTINGWAVDATA');

  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: webDist, wildcard: false });

  // The asset prefixes served by fastify-static plugins — a GET that misses a
  // real file under one of these must hard-404 (matches src/index.ts).
  const ASSET_404_PREFIXES = ['/chimes/', '/audio-render/', '/audio/'];
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method !== 'GET' ||
      req.url.startsWith('/api/') ||
      req.url.startsWith('/ws') ||
      ASSET_404_PREFIXES.some((p) => req.url.startsWith(p))
    ) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });

  await app.register(fastifyStatic, { root: audioDir, prefix: '/audio/', decorateReply: false, wildcard: false });
  await app.register(fastifyStatic, { root: audioRenderDir, prefix: '/audio-render/', decorateReply: false, wildcard: true });
  await app.register(fastifyStatic, { root: chimesDir, prefix: '/chimes/', decorateReply: false, wildcard: true });
  return app;
}

test('GET /chimes/<missing>.wav hard-404s instead of serving the SPA index.html', async () => {
  const app = await buildApp();
  try {
    const r = await app.inject({ method: 'GET', url: '/chimes/nonexistent.wav' });
    assert.equal(r.statusCode, 404, `expected 404 for a missing tone, got ${r.statusCode}`);
    assert.ok(!/Power SPA/.test(r.body), 'a missing tone returned the SPA index.html (HTML 200 masquerade)');
  } finally {
    await app.close();
  }
});

test('GETs for missing assets under all three audio prefixes hard-404', async () => {
  const app = await buildApp();
  try {
    for (const url of ['/audio/missing.wav', '/audio-render/missing.wav', '/chimes/missing.wav']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 404, `expected 404 for ${url}, got ${r.statusCode}`);
      assert.ok(!/Power SPA/.test(r.body), `${url} fell through to the SPA index.html`);
    }
  } finally {
    await app.close();
  }
});

test('a deep SPA route still serves index.html (404 scope not over-broadened)', async () => {
  const app = await buildApp();
  try {
    const r = await app.inject({ method: 'GET', url: '/alerts/some/deep/route' });
    assert.equal(r.statusCode, 200, `expected SPA fallback 200, got ${r.statusCode}`);
    assert.ok(/Power SPA/.test(r.body), 'SPA deep-link fallback no longer serves index.html');
  } finally {
    await app.close();
  }
});

test('existing assets under all three audio prefixes still serve 200 (fix did not over-broaden the 404)', async () => {
  const app = await buildApp();
  try {
    for (const url of ['/audio/existing.wav', '/audio-render/existing.wav', '/chimes/existing.wav']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `expected a real asset at ${url} to serve 200, got ${r.statusCode}`);
      assert.ok(/RIFFEXISTINGWAVDATA/.test(r.body), `${url} did not return the real asset bytes`);
      assert.ok(!/Power SPA/.test(r.body), `${url} returned the SPA index.html instead of the asset`);
    }
  } finally {
    await app.close();
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
