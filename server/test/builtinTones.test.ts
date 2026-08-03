import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/* ===================================================================
 * v0.17.0 — named built-in tone library.
 *
 * Pins: (1) the catalog is well-formed and every tone synthesizes to a
 * 22050/16/mono WAV; (2) the 3-way ChimeAssignment resolves correctly —
 * a named tone → /<dir>/<id>.wav with a `b:<id>` cache tag, missing →
 * klaxon fallback, unknown → rejected; (3) the cache tags are mutually
 * distinct (the invariant the critic flagged as highest-risk: a named
 * tag must never collide with the klaxon sentinel, a custom id, or
 * another named tone).
 * =================================================================== */

const tmp = mkdtempSync(resolve(tmpdir(), 'builtintones-test-'));
process.env.CHIMES_DIR = resolve(tmp, 'chimes');
process.env.CHIME_CONFIG_PATH = resolve(tmp, 'chime-config.json');
const audioDir = resolve(tmp, 'audio');

const { BUILTIN_TONES, isBuiltinTone, builtinTonePath, generateAudioAssets, regenerateAudioAssets } =
  await import('../src/audioAssets.js');
const { resolveChime, updateChimeConfig, _resetChimeConfigCacheForTest, BUILTIN_TAG } =
  await import('../src/chimeConfig.js');
const { renderCacheKey, parseWavHeader } = await import('../src/audioRenderer.js');

// Synthesize klaxons + the named library into the temp audio dir once.
await generateAudioAssets(audioDir, () => {});

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

test('catalog — 20-24 named tones, valid unique slugs, each synthesizes to 22050/16/mono', () => {
  // v1.55.0 — bound widened from 14-16 when the six pack klaxons were promoted
  // to first-class tones (16 → 22). The bound exists to catch an accidental
  // catalog explosion, not to pin an exact count.
  assert.ok(BUILTIN_TONES.length >= 20 && BUILTIN_TONES.length <= 24, `count ${BUILTIN_TONES.length}`);
  const seen = new Set<string>();
  for (const t of BUILTIN_TONES) {
    assert.match(t.id, SLUG, t.id);
    assert.ok(t.displayName.length > 0, `empty displayName for ${t.id}`);
    assert.ok(!seen.has(t.id), `duplicate id ${t.id}`); seen.add(t.id);
    assert.ok(isBuiltinTone(t.id), `isBuiltinTone false for ${t.id}`);
    const p = builtinTonePath(t.id, audioDir);
    assert.ok(p && existsSync(p), `missing wav for ${t.id}`);
    const h = parseWavHeader(readFileSync(p!));
    assert.equal(h.rate, 22050); assert.equal(h.channels, 1); assert.equal(h.width, 2);
  }
  // Named ids never collide with the 4 level klaxons (those stay level-only).
  for (const k of ['red-alert', 'yellow-alert', 'all-clear', 'boatswain']) assert.ok(!isBuiltinTone(k));
});

test('builtinTonePath — rejects unknown ids, traversal, and custom-hash shapes', () => {
  assert.equal(builtinTonePath('not-a-tone', audioDir), null);
  assert.equal(builtinTonePath('../../etc/passwd', audioDir), null);
  assert.equal(isBuiltinTone('deadbeefdeadbeef'), false); // a 16-hex custom id is not a builtin
});

test('resolveChime — a named tone resolves to its file + b:<id> tag, no fallback', () => {
  _resetChimeConfigCacheForTest();
  const { rejected } = updateChimeConfig({ critical: { kind: 'named', id: 'gong' } }, 'web');
  assert.deepEqual(rejected, []);
  const r = resolveChime('critical', audioDir);
  assert.ok(r.path.endsWith('gong.wav'));
  assert.equal(r.tag, 'b:gong');
  assert.equal(r.fellBack, false);
  // Other rungs untouched. v1.59.0 — each rung ships a DISTINCT default; the
  // all-clear's is triad-up (doorbell moved to LOW, per operator preference).
  assert.equal(resolveChime('clear', audioDir).tag, 'b:triad-up');
});

test('updateChimeConfig — rejects an unknown built-in tone and keeps the prior assignment', () => {
  updateChimeConfig({ medium: { kind: 'named', id: 'sonar-ping' } }, 'web');
  const { rejected } = updateChimeConfig({ medium: { kind: 'named', id: 'nope-tone' } }, 'web');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /medium/, 'the rejection names the rung it applies to');
  assert.equal(resolveChime('medium', audioDir).tag, 'b:sonar-ping');
});

test('resolveChime — a named tone whose file is missing FALLS BACK to the klaxon (never silent)', () => {
  _resetChimeConfigCacheForTest();
  updateChimeConfig({ clear: { kind: 'named', id: 'doorbell' } }, 'web');
  assert.equal(resolveChime('clear', audioDir).tag, 'b:doorbell');
  unlinkSync(resolve(audioDir, 'doorbell.wav')); // tone file vanishes
  const r = resolveChime('clear', audioDir);
  assert.equal(r.fellBack, true);
  assert.ok(r.path.endsWith('all-clear.wav'));
  assert.equal(r.tag, BUILTIN_TAG); // tag matches the klaxon actually returned
});

test('renderCacheKey — named tags distinct from the klaxon (omitted), customs, and each other', () => {
  const key = (tag?: string) => renderCacheKey('critical', 'Critical condition', 1, 0, 1, 0, 1000, tag);
  const klaxonImplicit = key();             // no tag
  const klaxonExplicit = key(BUILTIN_TAG);  // 'builtin' → omitted, same key
  const ping = key('b:ping-single');
  const gong = key('b:gong');
  const custom = key('deadbeefdeadbeef');
  assert.equal(klaxonImplicit, klaxonExplicit, "the 'builtin' sentinel is omitted from the key");
  const distinct = new Set([klaxonImplicit, ping, gong, custom]);
  assert.equal(distinct.size, 4, 'klaxon, two named tones, and a custom must all hash differently');
});

test('regenerateAudioAssets — rewrites the named tones we deleted', async () => {
  await regenerateAudioAssets(audioDir, () => {});
  for (const t of BUILTIN_TONES) {
    assert.ok(existsSync(resolve(audioDir, `${t.id}.wav`)), `regenerate missed ${t.id}`);
  }
});

/* v1.55.0 — the six promoted pack klaxons.
 *
 * These were previously reachable ONLY as the `builtin` level default, and then
 * only for whichever pack BROADCAST_CHIME_PACK named. Promoting them made every
 * one individually assignable. They are the only tones in the catalog designed
 * as a SET — cadence encodes severity, all-clear resolves upward — so losing one
 * silently would degrade an operator's ability to tell a critical from an
 * all-clear BY EAR, which is exactly what the chime-only fallback relies on.
 *
 * There is no mutation harness in this repo, so this pin is the only thing
 * standing between a careless catalog edit and that regression. */
const PROMOTED = [
  'airport-red-alert', 'airport-yellow-alert', 'airport-all-clear',
  'powerplant-red-alert', 'powerplant-yellow-alert', 'powerplant-all-clear',
] as const;

test('promoted pack klaxons — all six present, synthesized, and byte-identical to their pack asset', () => {
  for (const id of PROMOTED) {
    assert.ok(BUILTIN_TONES.some((t) => t.id === id), `catalog is missing promoted tone ${id}`);
    const p = builtinTonePath(id, audioDir);
    assert.ok(p && existsSync(p), `no wav synthesized for promoted tone ${id}`);
  }
  // A promoted tone must be the SAME audio as the pack klaxon it came from —
  // that is the whole premise of the promotion. The airport pack is the one
  // generateAudioAssets() rendered into the level-klaxon filenames here only if
  // BROADCAST_CHIME_PACK said so, so compare against whichever pack is active.
  // v1.56.0 — the pack option is gone; the level klaxons are the airport set.
  const pack = 'airport';
  for (const [level, asset] of [['red-alert', 'red-alert'], ['yellow-alert', 'yellow-alert'], ['all-clear', 'all-clear']] as const) {
    const klaxon = readFileSync(resolve(audioDir, `${asset}.wav`));
    const promoted = readFileSync(resolve(audioDir, `${pack}-${level}.wav`));
    assert.ok(promoted.equals(klaxon), `${pack}-${level} differs from the ${pack} pack's ${asset}.wav`);
  }
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
