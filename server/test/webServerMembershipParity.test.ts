import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shp2ConnectedDpuSns as serverConnected,
  isShp2Connected as serverIsConnected,
} from '../src/shp2Membership.js';
import {
  shp2ConnectedDpuSns as webConnected,
  isShp2Connected as webIsConnected,
} from '../../web/src/shp2Membership.js';

/**
 * v1.146.0 — the web mirror and the server must agree, and now it is CHECKED.
 *
 * `web/src/shp2Membership.ts` is a hand-maintained literal copy of the server
 * module. Its own header says "if the contract changes, update both files in
 * lock-step" — and that has now failed three times. It was three server
 * revisions behind: a single `find` where the server had unioned across every
 * panel since v1.129.0, so with a second SHP2 present every DPU wired to it fell
 * out of the connected set and was silently dropped from EnergyFlow's fleet
 * totals and ThermalPanel.
 *
 * A comment demanding lock-step is not a mechanism. This is: both files export
 * pure functions, and the web module's only import is `import type`, which is
 * erased at runtime — so the real implementations can be run side by side
 * against the same fixtures. Drift now fails the build instead of shipping.
 */

type Dev = Record<string, unknown>;
const shp2 = (sn: string, sources: { sn: string; isConnected: boolean }[]): Dev => ({
  sn, deviceName: sn, productName: 'Smart Home Panel 2', online: true, lastUpdated: 1,
  projection: { kind: 'shp2', sources },
});
const dpu = (sn: string): Dev => ({
  sn, deviceName: sn, productName: 'Delta Pro Ultra', online: true, lastUpdated: 1,
  projection: { kind: 'dpu' },
});
const fleet = (...ds: Dev[]) => Object.fromEntries(ds.map((d) => [d.sn as string, d])) as never;

const CASES: Array<[string, ReturnType<typeof fleet>]> = [
  ['no devices at all', fleet()],
  ['DPUs but no panel', fleet(dpu('A'), dpu('B'))],
  ['one panel, two connected', fleet(shp2('P1', [{ sn: 'A', isConnected: true }, { sn: 'B', isConnected: true }]), dpu('A'), dpu('B'))],
  ['one panel, one disconnected', fleet(shp2('P1', [{ sn: 'A', isConnected: true }, { sn: 'B', isConnected: false }]))],
  // ★ THE DRIFT: the web mirror's single `find` saw only P1.
  ['TWO panels — the second panel\'s DPUs must not vanish',
    fleet(shp2('P1', [{ sn: 'A', isConnected: true }]), shp2('P2', [{ sn: 'C', isConnected: true }]), dpu('A'), dpu('C'))],
  ['two panels, the FIRST empty', fleet(shp2('P1', []), shp2('P2', [{ sn: 'C', isConnected: true }]))],
  ['a panel with no sources subtree at all', fleet({ ...shp2('P1', []), projection: { kind: 'shp2' } } as Dev)],
  ['a source with no sn', fleet(shp2('P1', [{ sn: '', isConnected: true } as never]))],
];

for (const [name, devices] of CASES) {
  test(`parity — ${name}`, () => {
    const a = [...serverConnected(devices)].sort();
    const b = [...webConnected(devices)].sort();
    assert.deepEqual(b, a, 'the web mirror must return exactly what the server returns');
  });
}

test('★ the second panel\'s DPUs are actually included, not just equal-by-both-being-wrong', () => {
  // A parity test alone would pass if BOTH were broken the same way. Pin the value.
  const devices = fleet(
    shp2('P1', [{ sn: 'A', isConnected: true }]),
    shp2('P2', [{ sn: 'C', isConnected: true }]),
    dpu('A'), dpu('C'),
  );
  assert.deepEqual([...webConnected(devices)].sort(), ['A', 'C']);
  assert.deepEqual([...serverConnected(devices)].sort(), ['A', 'C']);
});

test('parity — isShp2Connected, including the empty-set fallback', () => {
  // size 0 ⇒ true is DELIBERATE on both sides: a plant with no panel (or one whose
  // /quota has not hydrated) must not have its whole fleet filtered out.
  for (const set of [new Set<string>(), new Set(['A']), new Set(['A', 'B'])]) {
    for (const sn of ['A', 'B', 'Z']) {
      assert.equal(webIsConnected(sn, set), serverIsConnected(sn, set), `${sn} against {${[...set]}}`);
    }
  }
});

// ── ratios must share a population on both sides ─────────────────────────────
/**
 * v1.146.0 — these accumulate inside React component bodies, so there is no
 * exported function to drive. Source pins, and deliberately tight ones: this
 * release already caught three mutants surviving because a loose scan matched
 * text the mutant left in place while killing the branch that used it.
 */
const webSrc = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src/', rel), 'utf8');

test('★ the pool degradation ratio is PAIR-GATED', () => {
  // Two independent `!= null` filters meant a pack reporting its design capacity
  // but not its current one inflated the denominator alone — the pool rendered
  // degradation that did not exist.
  const s = webSrc('pages/ThermalPanel.tsx');
  assert.match(s, /if \(pk\.fullCapMah != null && pk\.designCapMah != null\) \{/);
  assert.ok(
    !/if \(pk\.fullCapMah != null\) fullMah \+=/.test(s),
    'the independently-filtered accumulation must be gone, not merely supplemented',
  );
});

test('★ the fleet capacity ratio is PAIR-GATED', () => {
  const s = webSrc('cards/DegradationCard.tsx');
  assert.match(s, /const capPairs = deg\.packs\.filter\(/);
  assert.match(s, /sumDefined\(capPairs\.map\(\(p\) => p\.currentCapacityKwh\)\)/);
  assert.match(s, /sumDefined\(capPairs\.map\(\(p\) => p\.designCapacityKwh\)\)/);
  assert.ok(
    !/sumDefined\(deg\.packs\.map\(\(p\) => p\.designCapacityKwh\)\)/.test(s),
    'the denominator must not be summed over the unfiltered pack list',
  );
});

test('an ABSENT degradation report is not stamped with the current time', () => {
  // Inert today — no Plant screen reads data.degradation — which is exactly why
  // it would have been believed the first time something did.
  const s = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/telnet/session.ts'), 'utf8');
  assert.match(s, /degradation: d\.degradation\(\) \?\? \{ generatedAt: 0,/);
  assert.ok(!/generatedAt: Date\.now\(\), eolSoh: 80/.test(s));
});
