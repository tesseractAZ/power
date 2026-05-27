import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngineFromList, type TtsEngine } from '../src/ttsService.js';
import { buildEngineChain } from '../src/broadcast.js';

/**
 * v0.9.65 — "No Cloud TTS, ever" mode.
 *
 * Two complementary controls land in this release:
 *
 *   1. `BROADCAST_TTS_REQUIRE_LOCAL=true` — restricts the TTS candidate
 *      pool to engines with `local: true`. If no local engine is
 *      installed, TTS is disabled outright. Broadcasts still fire the
 *      klaxon — but never call Cloud.
 *   2. `BROADCAST_TTS_SERVICE=<name>` (non-empty) — pins the engine and
 *      DISABLES the fallback chain. If the pinned engine fails at
 *      runtime, the broadcast records the failure rather than walking
 *      to the next detected engine (which, pre-v0.9.65, would often
 *      land on Cloud).
 *
 * The two flags compose: pin-a-local-engine + REQUIRE_LOCAL is a sane
 * "Piper only, no surprises" config.
 *
 * These tests cover the pure pick + chain logic so we can lock in the
 * behavior without standing up a fake HA supervisor. The runtime
 * detection path (`detectTtsEngines` → HA service catalog) is exercised
 * by manual broadcast-test against the real HA instance.
 */

/* ─── fixtures ─────────────────────────────────────────────────────── */

const piper: TtsEngine = { service: 'tts.speak:tts.piper', label: 'Piper (local)',          local: true,  quality: 1 };
const cloud: TtsEngine = { service: 'tts.speak:tts.home_assistant_cloud', label: 'HA Cloud (Nabu Casa)', local: false, quality: 1 };
const google: TtsEngine = { service: 'tts.google_translate_say', label: 'Google Translate Say', local: false, quality: 2 };
const piperLegacy: TtsEngine = { service: 'tts.piper', label: 'Piper (local)', local: true, quality: 1 };

/* ─── pickEngineFromList — REQUIRE_LOCAL filter ───────────────────── */

test('pickEngine — REQUIRE_LOCAL=true filters out non-local engines', () => {
  // Piper + Cloud present; REQUIRE_LOCAL must drop Cloud and pick Piper.
  const picked = pickEngineFromList([piper, cloud], null, true);
  assert.ok(picked, 'should pick something (Piper is local)');
  assert.equal(picked!.service, piper.service);
  assert.equal(picked!.local, true);
});

test('pickEngine — REQUIRE_LOCAL=true with no local engines returns null', () => {
  // Only cloud-based engines available; REQUIRE_LOCAL must return null
  // so the caller skips TTS entirely instead of falling back to Cloud.
  const picked = pickEngineFromList([cloud, google], null, true);
  assert.equal(picked, null);
});

test('pickEngine — REQUIRE_LOCAL=true honors a local pin', () => {
  // BROADCAST_TTS_SERVICE=tts.piper + REQUIRE_LOCAL=true → still picks Piper.
  const picked = pickEngineFromList([piper, cloud], 'tts.piper', true);
  assert.ok(picked);
  assert.equal(picked!.local, true);
});

test('pickEngine — REQUIRE_LOCAL=true refuses a non-local pin', () => {
  // BROADCAST_TTS_SERVICE=tts.cloud_say + REQUIRE_LOCAL=true → null.
  // The preferred engine is filtered out of the candidate pool before
  // normalization, so the lookup misses and we return null.
  const picked = pickEngineFromList([piper, cloud], 'cloud', true);
  assert.equal(picked, null);
});

test('pickEngine — default behavior (REQUIRE_LOCAL=false) unchanged', () => {
  // No filtering, no preference → returns highest-quality engine first.
  const picked = pickEngineFromList([piper, cloud, google], null, false);
  assert.ok(picked);
  assert.equal(picked!.service, piper.service);
});

test('pickEngine — default behavior with cloud-only fleet picks cloud', () => {
  // No local engines installed → without REQUIRE_LOCAL we happily pick Cloud.
  const picked = pickEngineFromList([cloud, google], null, false);
  assert.ok(picked);
  assert.equal(picked!.service, cloud.service);
});

/* ─── buildEngineChain — explicit pin disables fallback ───────────── */

test('engine chain — explicit BROADCAST_TTS_SERVICE produces single-element chain', () => {
  // Pinning Piper means "use Piper or nothing" — Cloud must NOT be appended.
  const chain = buildEngineChain(piper, [piper, cloud, google], {
    pinnedService: 'tts.piper',
    requireLocal: false,
  });
  assert.equal(chain.length, 1, 'pin disables fallback chain');
  assert.equal(chain[0].service, piper.service);
});

test('engine chain — explicit pin + REQUIRE_LOCAL=true on local pin still works', () => {
  // Two flags composed: pin Piper AND require local. Result is a chain
  // of exactly Piper — both flags agree.
  const chain = buildEngineChain(piper, [piper, cloud, google], {
    pinnedService: 'tts.piper',
    requireLocal: true,
  });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].local, true);
});

test('engine chain — pin + REQUIRE_LOCAL=true on non-local pin returns empty chain', () => {
  // Defense in depth: even if the caller somehow passed a non-local primary,
  // REQUIRE_LOCAL must prevent the broadcast from speaking via Cloud.
  // Empty chain → caller falls through to klaxon-only.
  const chain = buildEngineChain(cloud, [piper, cloud, google], {
    pinnedService: 'tts.cloud_say',
    requireLocal: true,
  });
  assert.equal(chain.length, 0, 'REQUIRE_LOCAL wins over a non-local pin');
});

test('engine chain — default behavior unchanged when both flags off', () => {
  // No pin, no REQUIRE_LOCAL → primary first, then every other detected
  // engine (deduped by service). This is the v0.9.63 behavior.
  const chain = buildEngineChain(piper, [piper, cloud, google], {
    pinnedService: null,
    requireLocal: false,
  });
  assert.equal(chain.length, 3);
  assert.equal(chain[0].service, piper.service);
  // Order of the appended engines follows the input order minus the
  // already-included primary.
  assert.equal(chain[1].service, cloud.service);
  assert.equal(chain[2].service, google.service);
});

test('engine chain — pin "" (empty string) is treated as no pin', () => {
  // Empty BROADCAST_TTS_SERVICE means "no preference" — the chain is
  // the full auto-pick fallback, NOT a single-element pin.
  const chain = buildEngineChain(piper, [piper, cloud], {
    pinnedService: '',
    requireLocal: false,
  });
  assert.equal(chain.length, 2);
  assert.equal(chain[0].service, piper.service);
  assert.equal(chain[1].service, cloud.service);
});

test('engine chain — REQUIRE_LOCAL=true (no pin) drops Cloud from fallback chain', () => {
  // Even without a pin, REQUIRE_LOCAL must not append Cloud to the chain.
  // This is the defense-in-depth case from the spec: if upstream auto-pick
  // somehow gave us Piper but ttsAvailable still includes Cloud, the chain
  // must not silently fall back to Cloud on a Piper failure.
  const chain = buildEngineChain(piper, [piper, cloud, google], {
    pinnedService: null,
    requireLocal: true,
  });
  assert.equal(chain.length, 1, 'only the local engine survives');
  assert.equal(chain[0].service, piper.service);
});

test('engine chain — REQUIRE_LOCAL=true with two local engines keeps both', () => {
  // Future-proof: as soon as a second local engine exists (e.g., a second
  // Piper voice or OpenedAI Speech), it should be eligible for fallback
  // even in REQUIRE_LOCAL mode.
  const secondLocal: TtsEngine = { service: 'tts.speak:tts.openedai', label: 'OpenedAI Speech', local: true, quality: 1 };
  const chain = buildEngineChain(piper, [piper, cloud, secondLocal], {
    pinnedService: null,
    requireLocal: true,
  });
  assert.equal(chain.length, 2);
  assert.equal(chain.every((e) => e.local), true, 'every engine in chain is local');
});

test('engine chain — pin emits a one-shot diagnostic log', () => {
  // The spec asks for `"broadcast: TTS engine pinned via BROADCAST_TTS_SERVICE=<svc> — fallback chain disabled"`.
  const logs: string[] = [];
  buildEngineChain(piperLegacy, [piperLegacy, cloud], {
    pinnedService: 'tts.piper',
    requireLocal: false,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /TTS engine pinned/);
  assert.match(logs[0], /BROADCAST_TTS_SERVICE=tts\.piper/);
  assert.match(logs[0], /fallback chain disabled/);
});

test('engine chain — REQUIRE_LOCAL + non-local pin emits "skipped" diagnostic', () => {
  // Spec-adjacent: when the two flags genuinely conflict, log clearly
  // so the user can fix their config.
  const logs: string[] = [];
  buildEngineChain(cloud, [cloud, google], {
    pinnedService: 'tts.cloud_say',
    requireLocal: true,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /REQUIRE_LOCAL=true/);
  assert.match(logs[0], /non-local/);
});

/* ─── loadBroadcastConfig env-var parsing ─────────────────────────── */

test('loadBroadcastConfig — BROADCAST_TTS_REQUIRE_LOCAL defaults to false', async () => {
  // Lazy import to avoid module-load-time env capture.
  const { loadBroadcastConfig } = await import('../src/broadcast.js');
  const prev = { ...process.env };
  delete process.env.BROADCAST_TTS_REQUIRE_LOCAL;
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.requireLocalTts, false);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — BROADCAST_TTS_REQUIRE_LOCAL=true parses true', async () => {
  const { loadBroadcastConfig } = await import('../src/broadcast.js');
  const prev = { ...process.env };
  process.env.BROADCAST_TTS_REQUIRE_LOCAL = 'true';
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.requireLocalTts, true);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — BROADCAST_TTS_REQUIRE_LOCAL=1 also parses true', async () => {
  // HA's add-on bool serialization can vary; we accept both common shapes.
  const { loadBroadcastConfig } = await import('../src/broadcast.js');
  const prev = { ...process.env };
  process.env.BROADCAST_TTS_REQUIRE_LOCAL = '1';
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.requireLocalTts, true);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — BROADCAST_TTS_REQUIRE_LOCAL=false stays false', async () => {
  const { loadBroadcastConfig } = await import('../src/broadcast.js');
  const prev = { ...process.env };
  process.env.BROADCAST_TTS_REQUIRE_LOCAL = 'false';
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.requireLocalTts, false);
  } finally {
    process.env = prev;
  }
});
