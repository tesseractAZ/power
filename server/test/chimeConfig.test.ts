import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Both paths are read at module-load time → set env BEFORE the imports.
const tmp = mkdtempSync(resolve(tmpdir(), 'chimecfg-test-'));
process.env.CHIMES_DIR = resolve(tmp, 'chimes');
process.env.CHIME_CONFIG_PATH = resolve(tmp, 'chime-config.json');

const { saveChime, deleteChime } = await import('../src/chimeStore.js');
const {
  getChimeConfig, updateChimeConfig, revertAssignmentsFor, resolveChime,
  _resetChimeConfigCacheForTest, BUILTIN_TAG, CHIME_LEVELS,
} = await import('../src/chimeConfig.js');

const KLAX = '/klaxons';

function aTone(freq: number): string {
  const frames = 4410;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(22050, 24); buf.writeUInt32LE(22050 * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * 2, 40);
  for (let f = 0; f < frames; f++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * f) / 22050) * 26000), 44 + f * 2);
  const r = saveChime(buf, `tone-${freq}.wav`);
  assert.ok(r.ok, r.error);
  return r.meta!.id;
}

test('default config — one DISTINCT shipped tone per rung (v1.59.0 — was all-doorbell)', () => {
  // v1.56.0 shipped the same tone on every level, which was fine when there were
  // three levels distinguished mainly by how often they fired. With five rungs
  // the defaults have to do real work: the chime-only fallback plays the tone
  // and NOTHING ELSE when TTS is unavailable, so on that path the tone is the
  // entire message. Identical defaults would make a critical indistinguishable
  // from an all-clear precisely when the spoken text is missing.
  //
  // Distinctness is the property worth pinning; the specific ids are pinned too
  // so a catalog edit that drops one is a test failure rather than a silent
  // fallback to `builtin`.
  _resetChimeConfigCacheForTest();
  const cfg = getChimeConfig();
  const EXPECTED: Record<string, string> = {
    critical: 'warble-fast',
    high: 'klaxon-honk',
    medium: 'pulse-slow',
    low: 'doorbell',
    clear: 'triad-up',
  };
  for (const lvl of CHIME_LEVELS) {
    assert.deepEqual(
      cfg.assignments[lvl],
      { kind: 'named', id: EXPECTED[lvl] },
      `default tone for '${lvl}'`,
    );
  }
  const ids = CHIME_LEVELS.map((l) => cfg.assignments[l].kind === 'named' && cfg.assignments[l].id);
  assert.equal(new Set(ids).size, CHIME_LEVELS.length, 'every rung ships a DISTINCT tone');
});

test('builtin stays REACHABLE after the default moved off it', () => {
  // The default moving to doorbell must not orphan `builtin`: it is still the
  // operator-selectable level klaxon AND the last-resort tone resolveChime()
  // falls back to when an assigned tone's file is missing. If a refactor ever
  // made this state unreachable, the anti-silent-alarm floor would go with it.
  _resetChimeConfigCacheForTest();
  const { rejected } = updateChimeConfig({ critical: { kind: 'builtin' } }, 'test');
  assert.deepEqual(rejected, []);
  assert.deepEqual(getChimeConfig().assignments.critical, { kind: 'builtin' });
  _resetChimeConfigCacheForTest();
});

test('resolveChime — builtin → klaxon path + BUILTIN_TAG, no fallback', () => {
  const r = resolveChime('critical', KLAX);
  assert.ok(r.path.endsWith('red-alert.wav'));
  assert.equal(r.tag, BUILTIN_TAG);
  assert.equal(r.fellBack, false);
  assert.equal(resolveChime('medium', KLAX).path.endsWith('yellow-alert.wav'), true);
  assert.equal(resolveChime('clear', KLAX).path.endsWith('all-clear.wav'), true);
});

test('updateChimeConfig — assign a custom tone; resolveChime returns its file + id tag', () => {
  const id = aTone(440);
  const { rejected } = updateChimeConfig({ critical: { kind: 'custom', id } }, 'web');
  assert.deepEqual(rejected, []);
  const r = resolveChime('critical', KLAX);
  assert.ok(r.path.endsWith(`${id}.wav`));
  assert.equal(r.tag, id);          // tag is the content id → busts the render cache
  assert.equal(r.fellBack, false);
  // Other levels untouched.
  assert.equal(resolveChime('medium', KLAX).tag, BUILTIN_TAG);
});

test('updateChimeConfig — rejects an unknown id and keeps the prior assignment', () => {
  const id = aTone(660);
  updateChimeConfig({ medium: { kind: 'custom', id } }, 'web');
  const { rejected } = updateChimeConfig({ medium: { kind: 'custom', id: 'deadbeefdeadbeef' } }, 'web');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /medium/, 'the rejection names the rung it applies to');
  // The good prior assignment survives the rejected patch.
  assert.equal(resolveChime('medium', KLAX).tag, id);
});

test('resolveChime — a deleted custom file FALLS BACK to the builtin (never silent)', () => {
  const id = aTone(770);
  updateChimeConfig({ clear: { kind: 'custom', id } }, 'web');
  assert.equal(resolveChime('clear', KLAX).tag, id);
  deleteChime(id); // file gone, but the assignment may still point at it
  _resetChimeConfigCacheForTest(); // simulate a fresh process reading the persisted assignment
  const r = resolveChime('clear', KLAX);
  assert.equal(r.fellBack, true);
  assert.ok(r.path.endsWith('all-clear.wav'));
  assert.equal(r.tag, BUILTIN_TAG); // tag matches the builtin audio actually returned
});

test('revertAssignmentsFor — deleting a tone reverts every level using it to builtin', () => {
  const id = aTone(990);
  updateChimeConfig({ critical: { kind: 'custom', id }, medium: { kind: 'custom', id } }, 'web');
  const reverted = revertAssignmentsFor(id);
  assert.equal(reverted, true);
  assert.equal(resolveChime('critical', KLAX).tag, BUILTIN_TAG);
  assert.equal(resolveChime('medium', KLAX).tag, BUILTIN_TAG);
  // Reverting again when nothing references it is a no-op.
  assert.equal(revertAssignmentsFor(id), false);
});

test('config survives a "restart" (re-read from disk) with the same assignment', () => {
  const id = aTone(523);
  updateChimeConfig({ critical: { kind: 'custom', id } }, 'web');
  _resetChimeConfigCacheForTest();
  assert.equal(getChimeConfig().assignments.critical.kind, 'custom');
  assert.equal(resolveChime('critical', KLAX).tag, id);
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
