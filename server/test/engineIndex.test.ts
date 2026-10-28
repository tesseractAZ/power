import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The engine index (docs/reference/A-feature-inventory.md, section A.13) is the census behind every
 * engine count in the prose, and scripts/lib/engineIndex.mjs holds it to the source; check-doc-claims.mjs
 * runs it in CI. The README had said "~40 analytics engines in a worker thread" with nothing holding the
 * number or the thread. These fixtures prove each check can fail, so a checker that silently stopped
 * checking would fail here, and the last tests run the checks on the tree itself.
 */

const ROOT = resolve(import.meta.dirname, '../..');
interface Summary { total: number; worker: number; main: number; both: number; strict: number; groups: Record<string, number> }
const lib = (await import(pathToFileURL(resolve(ROOT, 'scripts/lib/engineIndex.mjs')).href)) as {
  ENGINE_INDEX_FILE: string;
  ENGINE_INDEX_HEADING: string;
  ENGINE_GROUPS: readonly string[];
  ENGINE_COUNT_SURFACES: readonly string[];
  occursAsWord(text: string, identifier: string): boolean;
  checkEngineIndex(text: string, readSource: (path: string) => string | null): { problems: string[]; summary: Summary | null };
  checkReadmeEngineClaims(readme: string, summary: Summary): { problems: string[]; passes: string[] };
  sweepEngineCounts(surfaces: Array<{ path: string; text: string | null }>, summary: Summary): { problems: string[]; counted: number };
};

interface Row { engine: string; status?: string; thread?: string; tier?: string; code: string; num?: string }
const HEADER = '| # | Engine | What it computes | Status | Thread | Tier | Code | Output |';
const RULE = '|---|---|---|---|---|---|---|---|';

/** Six groups of two rows: worker/main alternate, one advisory-only row and one borderline row. */
function fixtureRows(): Row[][] {
  return lib.ENGINE_GROUPS.map((_, g) => [
    { engine: `Engine ${g}a`, thread: 'worker', code: `\`server/src/a.ts:engine${g}a\`` },
    { engine: `Engine ${g}b`, thread: 'main', code: `\`server/src/b.ts:engine${g}b\`` },
  ]);
}

/** Build an index section; `sentence` overrides the count sentence. */
function buildIndex(groups: Row[][], o: { sentence?: string; heading?: string; groupNames?: readonly string[] } = {}): string {
  let n = 0;
  const flat = groups.flat();
  const status = (r: Row) => r.status ?? 'live';
  const tier = (r: Row) => r.tier ?? 'core';
  const strict = flat.filter((r) => tier(r) === 'core' && status(r) !== 'advisory-only' && status(r) !== 'shadow').length;
  const sentence = o.sentence
    ?? `**${flat.length} engines**: **${flat.filter((r) => (r.thread ?? 'main') === 'worker').length}** in the analytics worker, `
      + `**${flat.filter((r) => (r.thread ?? 'main') === 'main').length}** on the main thread. Read strictly, the index holds **${strict}**.`;
  const out = ['# Appendix', '', '### A.12 Earlier', '', o.heading ?? '### A.13 Engine index', '', 'An engine is a unit.', '', sentence, ''];
  groups.forEach((rows, g) => {
    out.push(`#### ${(o.groupNames ?? lib.ENGINE_GROUPS)[g]}`, '', HEADER, RULE);
    for (const r of rows) {
      n++;
      out.push(`| ${r.num ?? n} | ${r.engine} | x | ${status(r)} | ${r.thread ?? 'main'} | ${tier(r)} | ${r.code} | y |`);
    }
    out.push('');
  });
  out.push('### Candidates for removal review', '', '| a | b |', '|---|---|', '| 1 | 2 |', '');
  return out.join('\n');
}

const SOURCES: Record<string, string> = {
  'server/src/a.ts': lib.ENGINE_GROUPS.map((_, g) => `export function engine${g}a() {}`).join('\n'),
  'server/src/b.ts': lib.ENGINE_GROUPS.map((_, g) => `export const engine${g}b = 1;`).join('\n'),
};
const reader = (files: Record<string, string> = SOURCES) => (path: string) => files[path] ?? null;
const check = (text: string, files?: Record<string, string>) => lib.checkEngineIndex(text, reader(files));
const expectProblem = (text: string, re: RegExp, files?: Record<string, string>) => {
  const { problems } = check(text, files);
  assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got:\n${problems.join('\n') || '(none)'}`);
};
const SUMMARY: Summary = {
  total: 62, worker: 27, main: 35, both: 0, strict: 45,
  groups: Object.fromEntries(lib.ENGINE_GROUPS.map((g, k) => [g, [8, 17, 11, 11, 7, 8][k]])),
};
const README_GROUPS = lib.ENGINE_GROUPS.map((g) => `| ${g} | ${SUMMARY.groups[g]} | examples |`).join('\n');

test('a well-formed index passes, and its tallies are read from the rows', () => {
  const groups = fixtureRows();
  groups[0][1].status = 'advisory-only';
  groups[1][0].tier = 'borderline';
  const { problems, summary } = check(buildIndex(groups));
  assert.deepEqual(problems, []);
  assert.equal(summary?.total, 12);
  assert.equal(summary?.worker, 6);
  assert.equal(summary?.main, 6);
  assert.equal(summary?.strict, 10);
  assert.deepEqual(Object.values(summary?.groups ?? {}), [2, 2, 2, 2, 2, 2]);
});

test('a renamed identifier fails, naming the row', () => {
  const files = { ...SOURCES, 'server/src/a.ts': SOURCES['server/src/a.ts'].replace('engine2a', 'engine2aRenamed') };
  expectProblem(buildIndex(fixtureRows()), /row 5 Engine 2a: `engine2a` does not occur in server\/src\/a\.ts/, files);
});

test('an identifier that occurs only as the prefix of a longer one fails', () => {
  assert.equal(lib.occursAsWord('computeSoilingDecomposition()', 'computeSoiling'), false);
  assert.equal(lib.occursAsWord('x.computeSoiling(1)', 'computeSoiling'), true);
  assert.equal(lib.occursAsWord('$computeSoiling', 'computeSoiling'), false);
  const files = { ...SOURCES, 'server/src/a.ts': SOURCES['server/src/a.ts'].replace('engine0a()', 'engine0aDecomposition()') };
  expectProblem(buildIndex(fixtureRows()), /`engine0a` does not occur/, files);
});

test('a missing source file fails', () => {
  const files = { 'server/src/a.ts': SOURCES['server/src/a.ts'] };
  expectProblem(buildIndex(fixtureRows()), /server\/src\/b\.ts does not exist/, files);
});

test('a Code cell that is not `server/src/<file>:<identifier>` fails', () => {
  const groups = fixtureRows();
  groups[0][0].code = '`server/src/a.ts · engine0a`';
  expectProblem(buildIndex(groups), /Code cell .* is not/);
  groups[0][0].code = '`server/src/../a.ts:engine0a`';
  expectProblem(buildIndex(groups), /Code cell .* is not/);
});

test('a duplicate file:identifier pair and a duplicate engine name fail', () => {
  const groups = fixtureRows();
  groups[3][0].code = groups[0][0].code;
  expectProblem(buildIndex(groups), /anchors another row too/);
  const named = fixtureRows();
  named[2][1].engine = named[0][0].engine;
  expectProblem(buildIndex(named), /the engine name appears twice/);
});

test('a numbering gap fails', () => {
  const groups = fixtureRows();
  groups[2][0].num = '6';
  expectProblem(buildIndex(groups), /numbered "6", expected 5/);
});

test('an unknown status, thread, tier or group fails', () => {
  for (const [field, value, re] of [
    ['status', 'beta', /unknown status "beta"/],
    ['thread', 'gpu', /unknown thread "gpu"/],
    ['tier', 'fringe', /unknown tier "fringe"/],
  ] as const) {
    const groups = fixtureRows();
    groups[1][1][field] = value;
    expectProblem(buildIndex(groups), re);
  }
  const names = [...lib.ENGINE_GROUPS];
  names[4] = 'Miscellany';
  const text = buildIndex(fixtureRows(), { groupNames: names });
  expectProblem(text, /unknown group "Miscellany"/);
  expectProblem(text, /group "Learning & anomaly detection" is missing/);
});

test('a group with no rows fails', () => {
  const groups = fixtureRows();
  groups[5] = [];
  expectProblem(buildIndex(groups, { sentence: '**10 engines**: **5** in the analytics worker, **5** on the main thread. It holds **10**.' }), /group "Telemetry integrity" has no rows/);
});

test('a stray pipe inside a cell fails', () => {
  const groups = fixtureRows();
  groups[0][0].engine = 'Solar | PV';
  expectProblem(buildIndex(groups), /9 cells where the header has 8/);
});

test('a count sentence that disagrees with the rows fails, and so does a missing one', () => {
  const groups = fixtureRows();
  expectProblem(buildIndex(groups, { sentence: '**13 engines**: **6** in the analytics worker, **6** on the main thread. It holds **12**.' }), /says 13 for "\*\*N engines\*\*"; its rows give 12/);
  expectProblem(buildIndex(groups, { sentence: '**12 engines**: **7** in the analytics worker, **6** on the main thread. It holds **12**.' }), /says 7 for "\*\*N\*\* in the analytics worker"; its rows give 6/);
  expectProblem(buildIndex(groups, { sentence: '**12 engines**: **6** in the analytics worker, **5** on the main thread. It holds **12**.' }), /on the main thread"; its rows give 6/);
  expectProblem(buildIndex(groups, { sentence: '**12 engines**: **6** in the analytics worker, **6** on the main thread. It holds **11**.' }), /says 11 for "holds \*\*N\*\*"; its rows give 12/);
  expectProblem(buildIndex(groups, { sentence: '**12 engines**: **6** in the analytics worker, **6** on the main thread.' }), /no longer states "holds \*\*N\*\*"/);
});

test('an "on both" clause is required when a row runs on both, and refused when none does', () => {
  expectProblem(buildIndex(fixtureRows(), { sentence: '**12 engines**: **6** in the analytics worker, **6** on the main thread, **1** on both. It holds **12**.' }), /says 1 on both, but no row runs on both/);
  const groups = fixtureRows();
  groups[0][0].thread = 'both';
  expectProblem(buildIndex(groups, { sentence: '**12 engines**: **5** in the analytics worker, **6** on the main thread. It holds **12**.' }), /no longer states "\*\*N\*\* on both"/);
  const ok = check(buildIndex(groups, { sentence: '**12 engines**: **5** in the analytics worker, **6** on the main thread, **1** on both. It holds **12**.' }));
  assert.deepEqual(ok.problems, []);
});

test('a missing index heading fails as GONE, with no summary to check prose against', () => {
  const r = check(buildIndex(fixtureRows(), { heading: '### A.13 Engines' }));
  assert.equal(r.summary, null);
  assert.ok(r.problems.some((p) => /engine index GONE/.test(p)), r.problems.join('\n'));
});

test('the README floor must sit below the strict reading and the total', () => {
  const claim = (floor: string) => lib.checkReadmeEngineClaims(`It runs **${floor} engines** in six groups.\n\n${README_GROUPS}\n`, SUMMARY);
  assert.deepEqual(claim('more than 40').problems, []);
  assert.match(claim('more than 50').problems.join('\n'), /not below the strict reading 45/);
  assert.match(claim('more than 62').problems.join('\n'), /the index holds 62/);
  assert.match(lib.checkReadmeEngineClaims(README_GROUPS, SUMMARY).problems.join('\n'), /engine floor GONE/);
});

test('each README group row must state its group\'s tally, once', () => {
  const offByOne = README_GROUPS.replace('| Alarms & safety | 11 |', '| Alarms & safety | 12 |');
  assert.match(lib.checkReadmeEngineClaims(`**more than 40 engines**\n${offByOne}`, SUMMARY).problems.join('\n'), /Alarms & safety has 12, the index has 11/);
  const dropped = README_GROUPS.split('\n').filter((l) => !l.startsWith('| Forecasting')).join('\n');
  assert.match(lib.checkReadmeEngineClaims(`**more than 40 engines**\n${dropped}`, SUMMARY).problems.join('\n'), /0 "\| Forecasting \| N \|" rows, expected 1/);
});

test('the sweep refuses approximate, stale and worker-thread engine counts and accepts the floor', () => {
  const sweep = (text: string | null) => lib.sweepEngineCounts([{ path: 'x.md', text }], SUMMARY).problems;
  assert.deepEqual(sweep('Power runs more than 40 engines.'), []);
  assert.deepEqual(sweep('description: >-\n  built on\n  more than 40 engines: a plan'), []);
  assert.deepEqual(sweep('The index lists **62 engines**.'), []);
  assert.deepEqual(sweep('the three write-capable engines'), []);
  assert.match(sweep('runs **~40 analytics engines** in a worker thread').join('\n'), /approximately/);
  assert.match(sweep('runs **~40 analytics engines** in a worker thread').join('\n'), /in a worker thread/);
  assert.match(sweep('analytics worker (≈40 engines)').join('\n'), /approximately/);
  assert.match(sweep('40+ engines').join('\n'), /approximately/);
  assert.match(sweep('runs 40 engines').join('\n'), /neither the index total/);
  assert.match(sweep('more than 62 engines').join('\n'), /not below the strict reading 45/);
  assert.match(sweep('more than 50 engines').join('\n'), /not below the strict reading 45/);
  assert.match(sweep(null).join('\n'), /does not exist/);
});

test('the engine index in the tree passes against the source, and the prose against the index', () => {
  const read = (rel: string): string | null => {
    try { return readFileSync(resolve(ROOT, rel), 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const index = lib.checkEngineIndex(read(lib.ENGINE_INDEX_FILE) ?? '', read);
  assert.deepEqual(index.problems, []);
  assert.ok(index.summary && index.summary.total > 40);
  const readme = lib.checkReadmeEngineClaims(read('README.md') ?? '', index.summary);
  assert.deepEqual(readme.problems, []);
  const guide = readdirSync(resolve(ROOT, 'docs/guide')).filter((f) => f.endsWith('.md')).map((f) => `docs/guide/${f}`);
  const sweep = lib.sweepEngineCounts([...lib.ENGINE_COUNT_SURFACES, ...guide].map((path) => ({ path, text: read(path) })), index.summary);
  assert.deepEqual(sweep.problems, []);
  assert.ok(sweep.counted >= 4, `expected the floor on the README, the add-on README, its config and the reference index; counted ${sweep.counted}`);
});
