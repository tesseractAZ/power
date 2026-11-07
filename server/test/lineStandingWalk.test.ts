import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkYear, closeUnder, panelGridAt, WALK_HOURS_ALL, WALK_HOURS_SAMPLE, type Basis, type WalkCase, type WalkRow } from './fixtures/lineStandingWalk.js';

/**
 * v1.200.1 — THE YEAR ON A STANDING 50, walked through the real decisions (fixtures/lineStandingWalk.ts). Case A: 50 at the plan and the open. B: 50 at the plan, the
 * plant's own floor at the open. C: the own floor at the plan, 50 at the open. O: the plant's own floor throughout. W: 49 throughout, the written control of A.
 * The suite walks four hours; A5_IDENTITY_FULL=1 walks every hour, as the gates run it. STANDING_WALK_WRITE=1 writes lineStanding.walkIdentity.json (on a3588d96 only).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures/lineStanding.walkIdentity.json');
const FULL = process.env.A5_IDENTITY_FULL === '1' || process.env.STANDING_WALK_WRITE === '1';
const HOURS = FULL ? WALK_HOURS_ALL : WALK_HOURS_SAMPLE;
const ROWS = walkYear(HOURS, new Set<WalkCase>(['A', 'B', 'C', 'O', 'W']));

/** No-move walks, one digest per group: what writes went and what the night did, the rationale with them on the own floor. */
const FIELDS = ['label', 'L', 'reason', 'armedAsk', 'shortfall', 'rationale', 'close', 'onMin', 'reOns', 'onAt', 'onMode', 'bought', 'writes', 'push', 'onPool', 'applied', 'verified', 'ask', 'offReason', 'ceilRestored', 'closed', 'account', 'wMin'] as const;
const digest = (rows: WalkRow[]): { n: number; sha: string } => ({
  n: rows.length, sha: createHash('sha256').update(rows.map((r) => JSON.stringify(FIELDS.map((k) => r[k] ?? null))).join('\n')).digest('hex').slice(0, 24),
});
const group = (cs: 'O' | 'W', b: Basis, h: number) => digest(ROWS.filter((r) => r.cs === cs && r.b === b && r.h === h));

if (process.env.STANDING_WALK_WRITE === '1') {
  const groups: Record<string, { n: number; sha: string }> = {};
  for (const cs of ['O', 'W'] as const) for (const b of ['np', 'm'] as const) for (const h of WALK_HOURS_ALL) groups[`${cs}|${b}|${h}`] = group(cs, b, h);
  writeFileSync(FIXTURE, `${JSON.stringify({ generatedOn: 'a3588d96', walks: Object.values(groups).reduce((n, g) => n + g.n, 0), groups }, null, 1)}\n`);
  test('wrote the walk identity fixture', () => { assert.ok(true); });
} else {
  const FX = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { generatedOn: string; walks: number; groups: Record<string, { n: number; sha: string }> };

  test(`★★★ W1 the identity: every walk with no move of the reserve writes and does what ${FX.generatedOn} did, to the rationale (${FULL ? 'every hour' : `sample: ${WALK_HOURS_SAMPLE.join(', ')} h`})`, () => {
    let walks = 0;
    for (const cs of ['O', 'W'] as const) for (const b of ['np', 'm'] as const) for (const h of HOURS) {
      const g = group(cs, b, h);
      assert.deepEqual(g, FX.groups[`${cs}|${b}|${h}`], `${cs} ${b} ${h}`);
      walks += g.n;
    }
    if (FULL) assert.equal(walks, FX.walks);
    assert.equal(ROWS.filter((r) => (r.cs === 'O' || r.cs === 'W') && r.standing).length, 0, 'no stamp on a no-move walk');
  });

  const cell = (cs: WalkCase, b: Basis, h: number) => ROWS.filter((r) => r.cs === cs && r.b === b && r.h === h && (cs === 'C' || r.stands === true));
  const mean = (xs: number[]): number => Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10;
  const stat = (rs: WalkRow[]) => ({
    nights: rs.length, on: rs.filter((r) => r.onMin > 0).length, cost: rs.filter((r) => r.onMode === 'cost').length, under: rs.filter(closeUnder).length,
    close: mean(rs.map((r) => r.close!)), onMin: Math.round(mean(rs.filter((r) => r.onMin > 0).map((r) => r.onMin))),
  });
  const PIN_A: Record<string, ReturnType<typeof stat>> = {
    'np|4': { nights: 233, on: 233, cost: 79, under: 18, close: 73, onMin: 116 }, 'np|8': { nights: 247, on: 247, cost: 52, under: 48, close: 78.5, onMin: 134 },
    'np|12': { nights: 256, on: 256, cost: 23, under: 82, close: 84.5, onMin: 156 }, 'np|20': { nights: 257, on: 257, cost: 3, under: 161, close: 89.3, onMin: 175 },
    'm|4': { nights: 234, on: 234, cost: 78, under: 21, close: 73.2, onMin: 117 }, 'm|8': { nights: 248, on: 248, cost: 44, under: 52, close: 79.3, onMin: 137 },
    'm|12': { nights: 256, on: 256, cost: 20, under: 95, close: 85.3, onMin: 159 }, 'm|20': { nights: 257, on: 257, cost: 3, under: 170, close: 89.6, onMin: 176 },
  };

  test('★★★ W2 case A, a standing 50: every night rides, with no reserve write, no restore, and the ceiling back; the exposure is pinned', () => {
    for (const k of Object.keys(PIN_A)) {
      const [b, h] = k.split('|');
      const rs = cell('A', b as Basis, Number(h));
      assert.deepEqual(stat(rs), PIN_A[k], k);
      for (const r of rs) {
        assert.deepEqual([r.writes.reserve, r.writes.restore], [0, 0], `${r.label}: no reserve write and no restore on a standing record`);
        assert.equal(r.standing, true, r.label);
        assert.equal(r.applied, false, r.label);
        assert.equal(r.verified, false, r.label);
        assert.equal(r.ceilRestored, true, `${r.label}: the panel's own ceiling comes back`);
        assert.equal(r.account, 'standing', r.label);
        assert.ok(r.reOns <= 2, r.label);
        assert.ok(r.writes.on <= 3, `${r.label}: at most one ON and two line re-ONs`);
      }
    }
  });

  test('★★★ W3 case B, 50 at the plan and lowered by the open: the record has its ask, the write goes, the ON rides it, the restore comes; no stamp', () => {
    for (const b of ['np', 'm'] as const) for (const h of HOURS) {
      const rs = cell('B', b, h);
      assert.ok(rs.length > 0);
      for (const r of rs) {
        assert.deepEqual([r.writes.reserve, r.writes.restore, r.standing, r.onMin > 0, r.account], [1, 1, false, true, null], `${r.label} ${b} ${h}`);
      }
    }
    assert.deepEqual(stat(cell('B', 'np', 8)), { nights: 247, on: 247, cost: 52, under: 61, close: 76.2, onMin: 155 });
  });

  test('★★★ W4 case C, the own floor at the plan and 50 at the open: the night rides what it reads, with no write; it never ended "noWrite"', () => {
    for (const b of ['np', 'm'] as const) for (const h of HOURS) {
      for (const r of cell('C', b, h)) assert.deepEqual([r.writes.reserve, r.writes.restore, r.standing, r.account, r.closed === 'noWrite'], [0, 0, true, 'standing', false], `${r.label} ${b} ${h}`);
    }
  });

  /** Claimed (no disclosure on the plan) and under, against the written control one point lower. */
  const claimed = (cs: 'A' | 'W') => {
    const rs = ROWS.filter((r) => r.cs === cs && r.armedAsk != null && r.shortfall !== true
      && (cs === 'W' ? ROWS.some((a) => a.cs === 'A' && a.stands === true && a.label === r.label && a.b === r.b && a.h === r.h) : r.stands === true));
    return { claimed: rs.length, under: rs.filter(closeUnder).length };
  };
  const PIN_STANDING_CLAIMED = FULL ? { A: { claimed: 3854, under: 188 }, W: { claimed: 3978, under: 184 } } : { A: { claimed: 1005, under: 45 }, W: { claimed: 1026, under: 40 } };

  test('★★★ W5 PIN_STANDING_CLAIMED: the nights a standing 50 claims and closes under, beside the written control: the same order, and each short by what its line is higher', () => {
    assert.deepEqual({ A: claimed('A'), W: claimed('W') }, PIN_STANDING_CLAIMED);
    const worst = { n: 0, short: 0 };
    for (const a of ROWS.filter((r) => r.cs === 'A' && r.stands === true)) {
      const w = ROWS.find((r) => r.cs === 'W' && r.label === a.label && r.b === a.b && r.h === a.h);
      if (w == null || !closeUnder(a) || closeUnder(w)) continue;
      worst.n += 1;
      worst.short = Math.max(worst.short, Math.round((Math.min(a.L!, 100) - a.close!) * 100) / 100);
    }
    assert.ok(worst.short <= 2.02, `under at 50, held at 49: at most 2.02 points short (${worst.n} cells, worst ${worst.short})`);
  });

  /** The grid read false on every tick of [open, open + B min), then true: every stood night, with its written control. Sampled hours at every level. */
  const BLIPS = new Map<number, ReturnType<typeof blipOf>>();
  const blip = (B: number): ReturnType<typeof blipOf> => { if (!BLIPS.has(B)) BLIPS.set(B, blipOf(B)); return BLIPS.get(B)!; };
  const blipOf = (B: number) => {
    const rows = walkYear(WALK_HOURS_SAMPLE, new Set<WalkCase>(['A', 'W']), (t, open) => !(t >= open && t < open + B * 60_000));
    const a = rows.filter((r) => r.cs === 'A' && r.stands === true);
    const w = rows.filter((r) => r.cs === 'W');
    return {
      stood: a.length, stamped: a.filter((r) => r.standing).length, on: a.filter((r) => r.onAt != null).length, lost: a.filter((r) => r.gridLost === 1).length,
      lostTwice: a.filter((r) => r.gridLost > 1).length, ceilingWrites: a.reduce((n, r) => n + r.writes.ceiling, 0), reserveWrites: a.reduce((n, r) => n + r.writes.reserve + r.writes.restore, 0),
      accounts: [...new Set(a.map((r) => r.account))], written: w.length, writtenOn: w.filter((r) => r.onAt != null).length,
    };
  };

  test('★★★ W6 a grid read lost in the window, the year: no stood night rides after the blip, whatever its length, and each takes one stamp and the standing account', () => {
    const clean = blip(0);
    assert.equal(clean.on, clean.stood, 'the control: every night rides');
    assert.equal(clean.stamped, clean.stood);
    assert.equal(clean.lost, 0);
    for (const B of [1, 2, 6, 15, 30]) {
      const r = blip(B);
      assert.deepEqual(
        [r.stood, r.stamped, r.on, r.lost, r.lostTwice, r.ceilingWrites, r.reserveWrites, r.accounts],
        [clean.stood, 0, 0, clean.stood, 0, 0, 0, ['standing']],
        `grid false for ${B} min from the open`,
      );
      assert.equal(r.written, clean.written);
    }
    // The written control: its abort needs a tick after the apply, so a blip of one tick rides on it and two ticks do not.
    assert.equal(blip(1).writtenOn, clean.writtenOn);
    assert.equal(blip(2).writtenOn, 0);
  });

  test('★★★ W6 a grid the panel still reads lost at the open loses the ride, whenever that reading was taken, and a stood night that loses the grid after its stamp keeps its one stamp', () => {
    const clean = walkYear([4], new Set<WalkCase>(['A']));
    const pick = (rs: typeof clean) => rs.filter((r) => r.stands === true).map((r) => [r.label, r.b, r.standing, r.onAt, r.gridLost]);
    // The grid read from the panel's last quota, 30 s before each tick, through the real resolver (panelGridAt): the first tick of the window
    // reads a sample from before the open. A loss that ended 40 s before the open, that sample reading Grid OK: every night rides, as clean.
    const back = walkYear([4], new Set<WalkCase>(['A']), panelGridAt({ sta: (q, open) => (q < open - 40_000 ? 0 : 1) }));
    assert.ok(pick(clean).length > 0 && pick(clean).every((x) => x[2] === true && x[3] != null), 'the control: every stood night rides');
    assert.deepEqual(pick(back), pick(clean));
    // A loss that ended 10 s before the open, still in that sample; and replies that omit gridSta, the last that carried it a 0 three hours
    // before the open, Grid OK from open + 10. Each stood night: no stamp, no ON, no write, one grid-lost action (its one push) and no other,
    // and the standing account at the close.
    for (const [what, g] of [
      ['a 0 sampled before the open', panelGridAt({ sta: (q, open) => (q < open - 10_000 ? 0 : 1) })],
      ['an omitted gridSta carrying an old 0', panelGridAt({ sta: (q, open) => (q < open + 10 * 60_000 ? null : 1), carried: { sta: 0, atMs: (open) => open - 3 * 3_600_000 } })],
    ] as const) {
      const lost = walkYear([4], new Set<WalkCase>(['A']), g).filter((r) => r.stands === true);
      assert.equal(lost.length, pick(clean).length, what);
      for (const r of lost) {
        assert.deepEqual([r.standing, r.gridLost, r.onAt, r.push, r.writes.on, r.writes.ceiling, r.writes.reserve + r.writes.restore, r.account], [false, 1, null, null, 0, 0, 0, 'standing'], `${what}: ${r.label} ${r.b}`);
      }
    }
    const after = walkYear([4], new Set<WalkCase>(['A']), (t, open) => !(t >= open + 60_000 && t < open + 6 * 60_000)).filter((r) => r.stands === true);
    assert.ok(after.length > 0);
    for (const r of after) assert.deepEqual([r.standing, r.gridLost, r.onAt], [true, 1, null], `${r.label} ${r.b}: stamped on the open's tick, then one-way`);
  });
}
