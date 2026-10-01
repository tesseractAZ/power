/**
 * v1.187.1 — a removed pack's ghost slot stays hidden across a restart (general-1).
 *
 * v1.172.0 hid a frozen slot only once the live packs had moved PACK_STALE_MS past it, and after a
 * restart every slot is first seen at the same instant — so Core 4's slot 5 (its pack pulled on
 * 2026-09-20; the Core renumbered the rest 1-4) came back for ~10 minutes after every restart:
 * muted alerts on a pack that does not exist (dpu-imbalance "Lowest: Pack 5 at 55%", peer-soc,
 * peer-soh), HA's warning count one higher, three stale pack5_* samples per boot in the 5-year
 * store, ~3 rows into the full cleared-alert ledger — and the hide line printed the boot instant as
 * "frozen since". The recorder shows the slot byte-identical across ten days of restarts (55%,
 * 29 °C, 0 / 21 W, 3328 / 3325 mV, 31665 mAh).
 *
 * The hidden slot is now a persisted GHOST (fingerprint + how long it has stood unchanged). A slot
 * whose first reading in a new process is identical to its ghost keeps the ghost's time, so it is
 * hidden on the first projection; anything else is first seen "now", as before, and retires it.
 * Only a slot the REPEATED SERIAL hid is carried (review): a slot hidden by the Core's count alone is
 * what a pack that stopped reporting looks like, and nothing alarms on a hidden slot, so carrying it
 * would make that disappearance permanent and silent; it keeps v1.172.0's restart behaviour.
 * Pure rules here, then the store's file (PACK_GHOSTS_PATH) through two SnapshotStore instances.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-pack-ghost-'));
mkdirSync(join(tmp, 'db'));
process.env.DB_PATH = join(tmp, 'db', 'ecoflow.db'); // config.dbPath is read at import
delete process.env.SUPERVISOR_TOKEN;
delete process.env.PACK_GHOSTS_PATH;
after(() => rmSync(tmp, { recursive: true, force: true }));

const {
  prunePhantomPacks, freshPackSlotHistory, packFingerprint, parsePackGhosts, packFrozenPhrase, PACK_STALE_MS,
} = await import('../src/packPresence.js');
const { SnapshotStore, PACK_GHOSTS_RETRY_MS } = await import('../src/snapshot.js');

const M = 60_000;
const DAY = 24 * 60 * M;
const pk = (num: number, soc: number, mv: number, packSn = `PACK-${num}`) =>
  ({ num, soc, packVoltageMv: mv, maxCellVoltageMv: mv, minCellVoltageMv: mv - 5, temp: 30, cellVoltagesMv: [mv], cellTemps: [30], packSn } as any);
/** Core 4's slot 5: the old address of the pack now at slot 4 (it repeats slot 4's serial). */
const ghost5 = (soc = 55, mv = 3328) => pk(5, soc, mv, 'PACK-4');
/** Slots 1-4 live (moving every minute); slot 5 frozen at 55% / 3328 mV, repeating slot 4's serial,
 *  unless `slot5` says otherwise. */
const packsAt = (m: number, slot5 = ghost5()) => [1, 2, 3, 4].map((n) => pk(n, 70, 3330 + (m % 7))).concat([slot5]);

/** The first process: slot 5 is hidden once the live four have moved PACK_STALE_MS past it. */
function firstProcess() {
  const hist = freshPackSlotHistory();
  let r: ReturnType<typeof prunePhantomPacks> | null = null;
  for (let m = 0; m <= 30; m++) r = prunePhantomPacks(packsAt(m), 4, hist, m * M);
  assert.deepEqual(r!.dropped.map((d) => d.num), [5]);
  return hist;
}

/* ══ the pure rule ═══════════════════════════════════════════════════════ */

test('★★★ the 09-30 restart: the ghost is hidden on the FIRST projection of the next process, with its real time', () => {
  const a = firstProcess();
  const ghost = a.ghosts.get(5)!;
  assert.deepEqual(ghost, { fp: packFingerprint(ghost5()), frozenSinceMs: 0, changeSeen: false });
  // The next process, two days later: every slot is first seen now; the ghost's slot keeps its time.
  const b = freshPackSlotHistory(a.ghosts);
  const r = prunePhantomPacks(packsAt(0), 4, b, 2 * DAY);
  assert.deepEqual(r.packs.map((p) => p.num), [1, 2, 3, 4], 'not shown for ~10 minutes first');
  assert.deepEqual(r.dropped, [{ num: 5, frozenSinceMs: 0, changeSeen: false }]);
  assert.equal(r.ghostsChanged, false, 'nothing new to save');
  // The live four were first seen now, as before (no time is carried for them).
  assert.equal(b.changedMs.get(1), 2 * DAY);
});

test('★★★ without a pack count, the repeated serial hides the carried ghost at once too', () => {
  const a = freshPackSlotHistory();
  for (let m = 0; m <= 30; m++) prunePhantomPacks(packsAt(m), null, a, m * M);
  assert.ok(a.ghosts.has(5));
  const r = prunePhantomPacks(packsAt(0), null, freshPackSlotHistory(a.ghosts), 2 * DAY);
  assert.deepEqual(r.dropped.map((d) => d.num), [5]);
});

test('★★★ a slot hidden by the COUNT alone is not carried: after a restart it is shown until the live packs move (v1.172.0)', () => {
  // A pack that stopped reporting (loose cable, a BMS that shut down): the Core counts 4, slot 3's
  // readings freeze, and no other slot carries its serial. Nothing alarms on a hidden slot, so a
  // restart is the only time it comes back into view — that must not be taken away.
  const quiet = (m: number) => [1, 2, 4, 5].map((n) => pk(n, 70, 3330 + (m % 7))).concat([pk(3, 41, 3290)]).sort((x, y) => x.num - y.num);
  const a = freshPackSlotHistory();
  let r: ReturnType<typeof prunePhantomPacks> | null = null;
  const saved: boolean[] = [];
  for (let m = 0; m <= 30; m++) { r = prunePhantomPacks(quiet(m), 4, a, m * M); saved.push(r.ghostsChanged); }
  assert.deepEqual(r!.dropped.map((d) => d.num), [3], 'hidden in-process, as in v1.172.0');
  assert.equal(a.ghosts.size, 0, 'but not recorded as a ghost');
  assert.equal(saved.some(Boolean), false, 'so nothing is written');
  const b = freshPackSlotHistory(a.ghosts);
  assert.deepEqual(prunePhantomPacks(quiet(0), 4, b, 2 * DAY).packs.map((p) => p.num), [1, 2, 3, 4, 5], 'shown again after the restart');
});

test('★★★ a ghost whose serial no other slot carries any more is not carried (and is kept: its readings have not moved)', () => {
  const a = firstProcess();
  const b = freshPackSlotHistory(a.ghosts);
  // The next process: the pack at slot 4 has gone too (a different serial there); slot 5 still reads
  // its ghost. Carrying the ghost's time would let the count rule hide it on the first projection.
  const live = [1, 2, 3].map((n) => pk(n, 70, 3330)).concat([pk(4, 70, 3330, 'PACK-9'), ghost5()]);
  const r = prunePhantomPacks(live, 4, b, 2 * DAY);
  assert.deepEqual(r.packs.map((p) => p.num), [1, 2, 3, 4, 5], 'first seen now, like every slot');
  assert.equal(b.changedMs.get(5), 2 * DAY);
  assert.equal(b.ghosts.has(5), true, 'kept');
  assert.equal(r.ghostsChanged, false);
});

test('★★★ a re-inserted pack (any other reading in the slot) is first seen NOW: shown, and its ghost retired', () => {
  const a = firstProcess();
  const b = freshPackSlotHistory(a.ghosts);
  // A stale count of 4 from the cloud would let Rule 1 hide the slot if it carried the ghost's time.
  const r = prunePhantomPacks(packsAt(0, pk(5, 61, 3340, 'PACK-9')), 4, b, 2 * DAY);
  assert.deepEqual(r.packs.map((p) => p.num), [1, 2, 3, 4, 5], 'all first seen at once: nothing is hidden');
  assert.equal(b.changedMs.get(5), 2 * DAY);
  assert.equal(b.ghosts.has(5), false, 'the ghost is retired');
  assert.equal(r.ghostsChanged, true, 'and the retirement is saved');
});

test('★★ a ghost kept but not hidden (no count, no repeated serial) is retired the moment its slot moves', () => {
  const a = firstProcess();
  const b = freshPackSlotHistory(a.ghosts);
  const still = prunePhantomPacks(packsAt(0, pk(5, 55, 3328)), null, b, 2 * DAY);
  assert.equal(still.packs.length, 5, 'no rule applies without a count or a repeated serial');
  assert.equal(still.ghostsChanged, false);
  assert.ok(b.ghosts.has(5), 'still the same frozen readings: kept');
  const moved = prunePhantomPacks(packsAt(1, pk(5, 56, 3329)), null, b, 2 * DAY + M);
  assert.equal(b.ghosts.has(5), false);
  assert.equal(moved.ghostsChanged, true);
  assert.equal(b.changeSeen.has(5), true, 'an observed change, this time');
});

test('★★ a ghost dated after now (a backward clock step) counts from now: hidden only once the live packs move past it', () => {
  const a = firstProcess();
  const T = 2 * DAY;
  const future = new Map([[5, { ...a.ghosts.get(5)!, frozenSinceMs: T + DAY }]]);
  const b = freshPackSlotHistory(future);
  assert.equal(prunePhantomPacks(packsAt(0), 4, b, T).packs.length, 5, 'first seen now, like every slot');
  assert.equal(b.changedMs.get(5), T);
  let r: ReturnType<typeof prunePhantomPacks> | null = null;
  for (let m = 1; m <= PACK_STALE_MS / M + 1; m++) r = prunePhantomPacks(packsAt(m), 4, b, T + m * M);
  assert.deepEqual(r!.dropped.map((d) => d.num), [5], 'hidden on the in-process rule');
  assert.equal(b.ghosts.get(5)!.frozenSinceMs, T, 'and the saved time is corrected');
});

test('★★ a hidden slot that stays as it is is not re-saved on every projection; one that was SEEN to change keeps that', () => {
  const hist = freshPackSlotHistory();
  const changes: boolean[] = [];
  // Slot 5 moves for its first 3 minutes, then freezes at minute 3.
  for (let m = 0; m <= 30; m++) {
    const s5 = ghost5(55, m < 3 ? 3300 + m : 3328);
    changes.push(prunePhantomPacks(packsAt(m, s5), 4, hist, m * M).ghostsChanged);
  }
  assert.equal(changes.filter(Boolean).length, 1, 'saved once, when it was first hidden');
  assert.deepEqual(hist.ghosts.get(5), { fp: packFingerprint(ghost5()), frozenSinceMs: 3 * M, changeSeen: true });
  const r = prunePhantomPacks(packsAt(0), 4, freshPackSlotHistory(hist.ghosts), 2 * DAY);
  assert.deepEqual(r.dropped, [{ num: 5, frozenSinceMs: 3 * M, changeSeen: true }], 'carried with its observed change');
});

test('★★ the hide line says what the time is: an observed change is a date, a first sighting is a lower bound', () => {
  assert.equal(packFrozenPhrase({ frozenSinceMs: Date.UTC(2026, 8, 20, 19, 10), changeSeen: true }), 'readings unchanged since 2026-09-20T19:10:00.000Z');
  assert.equal(packFrozenPhrase({ frozenSinceMs: Date.UTC(2026, 8, 30, 13, 32), changeSeen: false }), 'readings unchanged since 2026-09-30T13:32:00.000Z or earlier');
  const first = firstProcess();
  assert.equal(first.changeSeen.has(5), false, 'v1.172.0 printed this first sighting as "frozen since"');
});

test('★★ the persisted file is validated entry by entry: anything malformed is skipped, never guessed at', () => {
  const ok = { fp: '["x"]', frozenSinceMs: 5, changeSeen: false };
  const parsed = parsePackGhosts({
    'CORE-OK': { 5: ok, 4: { ...ok, changeSeen: true } },
    'CORE-BAD': {
      'x': ok, 0: ok, 1.5: ok,
      2: { ...ok, fp: '' }, 3: { ...ok, fp: 7 },
      4: { ...ok, frozenSinceMs: 'soon' }, 5: { ...ok, frozenSinceMs: Infinity },
      6: { ...ok, changeSeen: 'yes' }, 7: null, 8: 'ghost',
    },
    'CORE-NULL': null,
    'CORE-ARRAY': [ok],
  });
  assert.deepEqual([...parsed.keys()], ['CORE-OK']);
  assert.deepEqual(parsed.get('CORE-OK'), new Map([[4, { ...ok, changeSeen: true }], [5, ok]]));
  for (const bad of [null, 'x', 7, [{ 'CORE-OK': { 5: ok } }]]) assert.equal(parsePackGhosts(bad).size, 0);
});

/* ══ the store: the file across two processes ══════════════════════════════ */

const CORE = 'COREXXX00XXX0004';
/** Core 4's raw quota at minute `m`: four live packs that move, slot 5 frozen (repeating slot 4's serial). */
function raw(m: number, slot5: 'ghost' | 'reinserted' = 'ghost'): Record<string, unknown> {
  const q: Record<string, unknown> = { 'hs_yj751_pd_appshow_addr.bpNum': slot5 === 'ghost' ? 4 : 5, 'hs_yj751_pd_appshow_addr.soc': 70 };
  for (let n = 1; n <= 5; n++) {
    const b = `hs_yj751_bms_slave_addr.${n}.`;
    const ghost = n === 5 && slot5 === 'ghost';
    q[`${b}soc`] = ghost ? 55 : 70;
    q[`${b}vol`] = ghost ? 53_100 : 53_000 + (m % 7) + n;
    q[`${b}maxCellVol`] = ghost ? 3328 : 3330 + (m % 7);
    q[`${b}minCellVol`] = ghost ? 3325 : 3320;
    q[`${b}temp`] = 29;
    q[`${b}packSn`] = ghost ? 'PACKXXX00XXX0004' : `PACKXXX00XXX000${n}`;
  }
  return q;
}
function store(t0: number) {
  const logs: string[] = [];
  const s = new SnapshotStore();
  let now = t0;
  s.setClock(() => now);
  s.setLogger((l) => logs.push(l));
  s.setDeviceList([{ sn: CORE, deviceName: 'Core 4', productName: 'Delta Pro Ultra', online: 1 } as never]);
  return { s, logs, at: (ms: number) => { now = ms; } };
}
const shown = (s: InstanceType<typeof SnapshotStore>) => ((s.get().devices[CORE].projection as any).packs as any[]).map((p) => p.num);
/** The first process: slot 5 hidden after the live packs move past it; returns its log. */
function hideInFirstProcess(): string[] {
  const a = store(0);
  for (let m = 0; m <= 12; m++) { a.at(m * M); a.s.setDeviceQuota(CORE, raw(m)); }
  assert.deepEqual(shown(a.s), [1, 2, 3, 4]);
  return a.logs;
}

test('★★★ the store saves the ghost where the next process reads it: hidden on its first projection', () => {
  const path = join(tmp, 'ghosts-restart.json');
  process.env.PACK_GHOSTS_PATH = path;
  try {
    const logs = hideInFirstProcess();
    assert.ok(logs.some((l) => l.includes('slot 5 has readings unchanged since 1970-01-01T00:00:00.000Z or earlier')), logs.join('\n'));
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), [CORE]);
    assert.equal(onDisk[CORE]['5'].frozenSinceMs, 0);

    const b = store(2 * DAY);
    b.s.setDeviceQuota(CORE, raw(0));
    assert.deepEqual(shown(b.s), [1, 2, 3, 4], 'hidden on the first projection — no ten-minute ghost after a restart');
    assert.ok(b.logs.some((l) => l.includes('slot 5 has readings unchanged since 1970-01-01T00:00:00.000Z or earlier')), 'the hide line carries the real time');

    // A pack put back in slot 5: shown at once, and the ghost leaves the file.
    const c = store(3 * DAY);
    c.s.setDeviceQuota(CORE, raw(0, 'reinserted'));
    assert.deepEqual(shown(c.s), [1, 2, 3, 4, 5]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
  } finally {
    delete process.env.PACK_GHOSTS_PATH;
  }
});

test('★★ a Core not projected yet keeps its ghosts in the file when another Core writes', () => {
  const path = join(tmp, 'ghosts-keep.json');
  const other = { 'COREXXX00XXX0009': { 3: { fp: '["y"]', frozenSinceMs: 1, changeSeen: true } } };
  writeFileSync(path, JSON.stringify(other));
  process.env.PACK_GHOSTS_PATH = path;
  try {
    hideInFirstProcess();
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(onDisk['COREXXX00XXX0009'], other['COREXXX00XXX0009']);
    assert.ok(onDisk[CORE]['5']);
  } finally {
    delete process.env.PACK_GHOSTS_PATH;
  }
});

test('★★ a corrupt file is ignored (the v1.172.0 behaviour: shown until the live packs move)', () => {
  const path = join(tmp, 'ghosts-corrupt.json');
  writeFileSync(path, '{ not json');
  process.env.PACK_GHOSTS_PATH = path;
  try {
    const b = store(2 * DAY);
    b.s.setDeviceQuota(CORE, raw(0));
    assert.deepEqual(shown(b.s), [1, 2, 3, 4, 5]);
  } finally {
    delete process.env.PACK_GHOSTS_PATH;
  }
});

test('★★ a failed save is logged once and retried (projections a minute apart: on each)', () => {
  const dir = join(tmp, 'not-yet');
  const path = join(dir, 'ghosts.json');
  process.env.PACK_GHOSTS_PATH = path;
  try {
    const a = store(0);
    for (let m = 0; m <= 12; m++) { a.at(m * M); a.s.setDeviceQuota(CORE, raw(m)); }
    for (let m = 13; m <= 15; m++) { a.at(m * M); a.s.setDeviceQuota(CORE, raw(m)); }
    assert.equal(a.logs.filter((l) => l.startsWith('packs: could not save the hidden pack slots')).length, 1);
    mkdirSync(dir);
    a.at(16 * M);
    a.s.setDeviceQuota(CORE, raw(16));
    assert.ok(existsSync(path), 'saved once the directory exists, though no ghost changed since');
    assert.ok(JSON.parse(readFileSync(path, 'utf8'))[CORE]['5']);
  } finally {
    delete process.env.PACK_GHOSTS_PATH;
  }
});

test('★★ (log review) a failed save is retried at most once per PACK_GHOSTS_RETRY_MS while no ghost changes — not on every ~1 Hz projection', () => {
  assert.equal(PACK_GHOSTS_RETRY_MS, 60_000);
  // A failing writer: the path is a directory, so each attempt writes the temp file and its rename
  // fails. The temp file is removed after every projection, so its reappearance counts an attempt.
  const path = join(tmp, 'ghosts-is-a-directory');
  mkdirSync(path);
  writeFileSync(join(path, 'occupied'), 'x');
  const tmpFile = `${path}.tmp`;
  process.env.PACK_GHOSTS_PATH = path;
  try {
    const a = store(0);
    const attempts: number[] = [];
    const project = (ms: number, slot5: 'ghost' | 'reinserted' = 'ghost', m = Math.floor(ms / M)) => {
      a.at(ms);
      a.s.setDeviceQuota(CORE, raw(m, slot5));
      if (existsSync(tmpFile)) { attempts.push(ms); rmSync(tmpFile); }
    };
    // The MQTT stream projects about once a second.
    let ms = 0;
    for (; attempts.length === 0 && ms <= 15 * M; ms += 1000) project(ms);
    const h = attempts[0];
    assert.ok(h != null, 'the hide saves the ghost — and the save fails');
    assert.deepEqual(shown(a.s), [1, 2, 3, 4]);
    for (; ms <= h + 5 * M; ms += 1000) project(ms);
    assert.deepEqual(attempts, [h, h + M, h + 2 * M, h + 3 * M, h + 4 * M, h + 5 * M],
      'one retry per minute, on the minute — not one per projection (300)');
    assert.equal(a.logs.filter((l) => l.startsWith('packs: could not save the hidden pack slots')).length, 1);
    assert.ok(a.logs.some((l) => l.endsWith('— retrying at most once a minute')), a.logs.join('\n'));
    // A genuine ghost change saves at once, ten seconds after the last attempt.
    const changeAt = h + 5 * M + 10_000;
    project(changeAt, 'reinserted');
    assert.deepEqual(shown(a.s), [1, 2, 3, 4, 5]);
    assert.equal(attempts.at(-1), changeAt, 'the retired ghost is saved at once');
    // A clock step backward does not hold the pending save off until the clock catches up (the
    // same readings: no ghost changes).
    const stepped = h - 10 * M;
    project(stepped, 'reinserted', Math.floor(changeAt / M));
    assert.equal(attempts.at(-1), stepped, 'retried at once after a backward clock step');
    // The writer recovers: the pending save lands on the next retry, not before.
    rmSync(path, { recursive: true });
    project(stepped + 30_000, 'reinserted', Math.floor(changeAt / M));
    assert.equal(existsSync(path), false, 'not before PACK_GHOSTS_RETRY_MS');
    project(stepped + M, 'reinserted', Math.floor(changeAt / M));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {}, 'saved on the next retry (the ghost was retired)');
  } finally {
    delete process.env.PACK_GHOSTS_PATH;
  }
});

test('★ outside the add-on, with no PACK_GHOSTS_PATH, nothing is written next to the database', () => {
  hideInFirstProcess();
  assert.equal(existsSync(join(tmp, 'db', 'pack-ghosts.json')), false);
});
