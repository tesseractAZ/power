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
interface Summary {
  total: number; worker: number; main: number; both: number; strict: number; live: number; gated: number;
  groups: Record<string, number>; rejected: number;
}
const lib = (await import(pathToFileURL(resolve(ROOT, 'scripts/lib/engineIndex.mjs')).href)) as {
  ENGINE_INDEX_FILE: string;
  ENGINE_INDEX_HEADING: string;
  ENGINE_GROUPS: readonly string[];
  ENGINE_COUNT_SURFACES: readonly string[];
  ENGINE_COUNT_SURFACE_DIRS: readonly string[];
  codeOnly(text: string): string;
  declares(text: string, identifier: string): boolean;
  checkEngineIndex(text: string, readSource: (path: string) => string | null): { problems: string[]; summary: Summary | null };
  checkReadmeEngineClaims(readme: string, summary: Summary): { problems: string[]; passes: string[]; floor: number | null };
  sweepEngineCounts(
    surfaces: Array<{ path: string; text: string | null }>,
    summary: Summary,
    floor: number | null,
  ): { problems: string[]; counted: number; floors: number };
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
  const live = flat.filter((r) => tier(r) === 'core' && status(r) === 'live').length;
  const sentence = o.sentence
    ?? `**${flat.length} engines**: **${flat.filter((r) => (r.thread ?? 'main') === 'worker').length}** in the analytics worker, `
      + `**${flat.filter((r) => (r.thread ?? 'main') === 'main').length}** on the main thread. Read strictly, the index holds **${strict}**. `
      + `Of those, ${live} are live; the other ${strict - live} wait on a channel or a write mode.`;
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
  total: 62, worker: 27, main: 35, both: 0, strict: 44, live: 39, gated: 3,
  groups: Object.fromEntries(lib.ENGINE_GROUPS.map((g, k) => [g, [8, 17, 11, 11, 7, 8][k]])),
  rejected: 0,
};
const README_GROUPS = lib.ENGINE_GROUPS.map((g) => `| ${g} | ${SUMMARY.groups[g]} | examples |`).join('\n')
  + '\n\nThe three write-capable engines sit behind mode gates.';

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
  assert.equal(summary?.live, 10);
  assert.equal(summary?.gated, 0);
  assert.equal(summary?.rejected, 0);
  assert.deepEqual(Object.values(summary?.groups ?? {}), [2, 2, 2, 2, 2, 2]);
});

test('a renamed identifier fails, naming the row', () => {
  const files = { ...SOURCES, 'server/src/a.ts': SOURCES['server/src/a.ts'].replace('engine2a', 'engine2aRenamed') };
  expectProblem(buildIndex(fixtureRows()), /row 5 Engine 2a: server\/src\/a\.ts does not declare `engine2a` in code/, files);
});

test('an identifier that occurs only as the prefix of a longer one fails', () => {
  assert.equal(lib.declares('export function computeSoilingDecomposition() {}', 'computeSoiling'), false);
  assert.equal(lib.declares('export async function computeSoiling(x) {}', 'computeSoiling'), true);
  assert.equal(lib.declares('const $computeSoiling = 1;', 'computeSoiling'), false);
  const files = { ...SOURCES, 'server/src/a.ts': SOURCES['server/src/a.ts'].replace('engine0a()', 'engine0aDecomposition()') };
  expectProblem(buildIndex(fixtureRows()), /does not declare `engine0a`/, files);
});

test('an identifier that survives only in a comment, a string or a call fails: a rename in code alone is caught', () => {
  // What an editor's symbol rename leaves behind: the declaration and the calls renamed, the comments not.
  const renamed = [
    '/**',
    ' * engine0a — the doc comment still names it, and so does the line below.',
    ' * export function engine0a() {}',
    ' */',
    '// function engine0a() was the old name',
    '/* const engine0a = 1; */',
    "const label = 'function engine0a';",
    'const note = `class engine0a ${1 + 1}`;',
    'export function engine0aRenamed() {}',
    'engine0aRenamed();',
  ].join('\n');
  for (const [what, text] of [
    ['a doc comment, a line comment, a block comment, a string and a template', renamed],
    ['a call to an engine declared elsewhere', 'import { engine0a } from "./elsewhere.js";\nengine0a();'],
  ] as const) {
    assert.equal(lib.declares(text, 'engine0a'), false, what);
    const files = { ...SOURCES, 'server/src/a.ts': SOURCES['server/src/a.ts'].replace('export function engine0a() {}', text) };
    expectProblem(buildIndex(fixtureRows()), /row 1 Engine 0a: server\/src\/a\.ts does not declare `engine0a` in code/, files);
  }
  for (const decl of ['function engine0a() {}', 'function* engine0a() {}', 'export const engine0a = () => 1;', 'let engine0a = 2;',
    'var engine0a;', 'export class engine0a {}', 'interface engine0a {}', 'type engine0a = number;', 'enum engine0a { A }']) {
    assert.equal(lib.declares(decl, 'engine0a'), true, decl);
  }
  assert.equal(lib.declares('x.function engine0a', 'engine0a'), false, 'a property named like a keyword is not a declaration');
});

test('code is told from comments and literals the way the parser does', () => {
  const keep = (src: string) => lib.codeOnly(src);
  // Length and line breaks are kept, so offsets and line numbers hold.
  const src = 'a // x\n/* y\n z */ b';
  assert.equal(keep(src).length, src.length);
  assert.equal(keep(src).split('\n').length, 3);
  // A regular expression holding a quote, a slash in a class and a comment opener stays one literal.
  assert.doesNotMatch(keep("const re = /['\"]/g; const RE2 = /[/]\\/*x/; function after() {}"), /['"]|\*x/);
  assert.match(keep("const re = /['\"]/g; function after() {}"), /function after/);
  // After an operand a slash divides: a non-null assertion, a call, an index, a number.
  for (const div of ['rttMs! / 2', 'f(x) / 2', 'a[0] / 2', '10 / 2']) {
    assert.match(keep(`const v = ${div}; function after() {}`), /function after/, div);
  }
  // A keyword used as a property name is an operand, and so is a postfix ++ or --. Read as a
  // regular expression, each slash below would open a literal that closes inside the template, and
  // the template's closing backtick would then open one that hides the declaration after it.
  for (const div of [
    'kwh.in / Math.max(p, 1); const s = `${a}/${b} packs`;',
    'kwh?.in / 2; const s = `${a}/${b}`;',
    'pv.yield / 2; const s = `${spec}/kWp`;',
    'n++ / 2; const u = `http://h/${half}`;',
    'n-- / 2; const u = `${a}/${b}`;',
  ]) {
    const src = `const v = ${div}\nexport function after() {}\n`;
    assert.match(keep(src), /function after/, div);
    assert.equal(lib.declares(src, 'after'), true, div);
  }
  // A prefix ++ after a keyword still leaves the slash after its operand a division.
  assert.match(keep('function f() { return ++n / 2; } const s = `${a}/${b}`; function after() {}'), /function after/);
  // After a keyword it opens a literal.
  assert.match(keep('function f() { return /}/.test(s); } function after() {}'), /function after/);
  // A template's text is blanked; its expressions, braces and nested templates stay code.
  const t = keep('const s = `x ${ { a: `y ${b}` }.a } function no`; function after() {}');
  assert.match(t, /\{ a: /);
  assert.match(t, /function after/);
  assert.doesNotMatch(t, /function no/);
  assert.doesNotMatch(keep("const s = 'it\\'s // not a comment'; function after() {}"), /not a comment/);
  assert.match(keep("const s = 'it\\'s // not a comment'; function after() {}"), /function after/);
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

test('a stray pipe inside a cell fails on its own, without misnumbering every later row', () => {
  const groups = fixtureRows();
  groups[0][0].engine = 'Solar | PV';
  const { problems, summary } = check(buildIndex(groups));
  assert.match(problems.join('\n'), /9 cells where the header has 8/);
  // One dropped row would shift every later row's number and leave every tally one short; those
  // follow-on problems would bury the cause, so they wait until the row parses.
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(summary?.rejected, 1);
});

test('an escaped pipe inside a cell is one cell, unescaped', () => {
  const groups = fixtureRows();
  groups[0][0].engine = 'Solar \\| PV';
  groups[2][1].engine = 'Gated on \\|innovation\\| < 3σ';
  const { problems, summary } = check(buildIndex(groups));
  assert.deepEqual(problems, []);
  assert.equal(summary?.total, 12);
  // A backslash escapes the character after it, so an escaped backslash before a pipe still splits.
  const split = fixtureRows();
  split[0][0].engine = 'Solar \\\\| PV';
  expectProblem(buildIndex(split), /9 cells where the header has 8/);
  // An escaped pipe at the end of the last cell is content, not the closing border.
  const index = buildIndex(fixtureRows()).replace('| y |', '| y \\| |');
  assert.deepEqual(check(index).problems, []);
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
  const ok = check(buildIndex(groups, { sentence: '**12 engines**: **5** in the analytics worker, **6** on the main thread, **1** on both. It holds **12**. Of those, 12 are live; the other 0 wait.' }));
  assert.deepEqual(ok.problems, []);
});

test('the strict reading\'s live and waiting split is pinned to the rows', () => {
  // Two core rows wait on an opt-in channel or a write mode: the strict reading stays 12, 10 are live.
  const groups = fixtureRows();
  groups[0][0].status = 'live-opt-in';
  groups[3][1].status = 'write-capable-gated';
  const base = '**12 engines**: **6** in the analytics worker, **6** on the main thread. It holds **12**.';
  assert.deepEqual(check(buildIndex(groups, { sentence: `${base} Of those, 10 are live; the other 2 wait on a channel.` })).problems, []);
  // A status flipped back to live leaves the sentence stale, and the check says so.
  expectProblem(buildIndex(groups, { sentence: `${base} Of those, 11 are live; the other 2 wait.` }), /says 11 for "Of those, N are live"; its rows give 10/);
  expectProblem(buildIndex(groups, { sentence: `${base} Of those, 10 are live; the other 1 wait.` }), /says 1 for "the other N wait"; its rows give 2/);
  expectProblem(buildIndex(groups, { sentence: base }), /no longer states "Of those, N are live"/);
  expectProblem(buildIndex(groups, { sentence: base }), /no longer states "the other N wait"/);
  // A borderline row leaves the strict reading, and the split with it.
  const borderline = fixtureRows();
  borderline[0][0].status = 'live-opt-in';
  borderline[0][0].tier = 'borderline';
  const { problems, summary } = check(buildIndex(borderline));
  assert.deepEqual(problems, []);
  assert.equal(summary?.strict, 11);
  assert.equal(summary?.live, 11);
});

test('a missing index heading fails as GONE, with no summary to check prose against', () => {
  const r = check(buildIndex(fixtureRows(), { heading: '### A.13 Engines' }));
  assert.equal(r.summary, null);
  assert.ok(r.problems.some((p) => /engine index GONE/.test(p)), r.problems.join('\n'));
});

test('the README floor must sit below the strict reading and the total', () => {
  const claim = (floor: string) => lib.checkReadmeEngineClaims(`It runs **${floor} engines** in six groups.\n\n${README_GROUPS}\n`, SUMMARY);
  assert.deepEqual(claim('more than 40').problems, []);
  assert.equal(claim('more than 40').floor, 40);
  assert.equal(lib.checkReadmeEngineClaims(README_GROUPS, SUMMARY).floor, null);
  assert.match(claim('more than 44').problems.join('\n'), /not below the strict reading 44/);
  assert.match(claim('more than 50').problems.join('\n'), /not below the strict reading 44/);
  assert.match(claim('more than 62').problems.join('\n'), /the index holds 62/);
  assert.match(lib.checkReadmeEngineClaims(README_GROUPS, SUMMARY).problems.join('\n'), /engine floor GONE/);
});

test('the README\'s count of write-capable engines must equal the index\'s write-capable-gated rows', () => {
  const groupsOnly = README_GROUPS.split('\n\n')[0];
  const claim = (sentence: string) => lib.checkReadmeEngineClaims(`**more than 40 engines**\n\n${groupsOnly}\n\n${sentence}\n`, SUMMARY).problems.join('\n');
  assert.equal(claim('The three write-capable engines sit behind mode gates.'), '');
  assert.equal(claim('The 3 write-capable\nengines sit behind mode gates.'), '');
  assert.match(claim('The four write-capable engines sit behind mode gates.'), /README says "four write-capable engines", the index has 3/);
  assert.match(claim('The two write-capable engines sit behind mode gates.'), /the index has 3 write-capable-gated row/);
  assert.match(claim('Some engines can write, behind mode gates.'), /write-capable count GONE/);
});

test('each README group row must state its group\'s tally, once', () => {
  const offByOne = README_GROUPS.replace('| Alarms & safety | 11 |', '| Alarms & safety | 12 |');
  assert.match(lib.checkReadmeEngineClaims(`**more than 40 engines**\n${offByOne}`, SUMMARY).problems.join('\n'), /Alarms & safety has 12, the index has 11/);
  const dropped = README_GROUPS.split('\n').filter((l) => !l.startsWith('| Forecasting')).join('\n');
  assert.match(lib.checkReadmeEngineClaims(`**more than 40 engines**\n${dropped}`, SUMMARY).problems.join('\n'), /0 "\| Forecasting \| N \|" rows, expected 1/);
});

test('the sweep refuses approximate, stale and worker-thread engine counts and accepts the floor', () => {
  const sweep = (text: string | null) => lib.sweepEngineCounts([{ path: 'x.md', text }], SUMMARY, 40).problems;
  assert.deepEqual(sweep('Power runs more than 40 engines.'), []);
  assert.deepEqual(sweep('description: >-\n  built on\n  more than 40 engines: a plan'), []);
  assert.deepEqual(sweep('The index lists **62 engines**.'), []);
  assert.deepEqual(sweep('the three write-capable engines'), []);
  assert.match(sweep('runs **~40 analytics engines** in a worker thread').join('\n'), /approximately/);
  assert.match(sweep('runs **~40 analytics engines** in a worker thread').join('\n'), /in a worker thread/);
  assert.match(sweep('analytics worker (≈40 engines)').join('\n'), /approximately/);
  assert.match(sweep('40+ engines').join('\n'), /approximately/);
  assert.match(sweep('runs 40 engines').join('\n'), /neither the index total/);
  assert.match(sweep('more than 62 engines').join('\n'), /not below the strict reading 44/);
  assert.match(sweep('more than 50 engines').join('\n'), /not below the strict reading 44/);
  assert.match(sweep('more than 44 engines').join('\n'), /not below the strict reading 44/);
  assert.match(sweep(null).join('\n'), /does not exist/);
});

test('the sweep reads a count through Markdown emphasis, and a bold floor is still a floor', () => {
  const sweep = (text: string) => lib.sweepEngineCounts([{ path: 'x.md', text }], SUMMARY, 40).problems.join('\n');
  for (const t of ['It runs more than **40 engines**.', 'It runs more than **40** engines.', 'It runs more than __40__ engines.', '**more than 40 engines**']) {
    assert.equal(sweep(t), '', t);
  }
  assert.match(sweep('It runs more than **50** engines.'), /"more than 50 engines" is not below the strict reading 44/);
  assert.match(sweep('It runs more than **50 engines**.'), /not below the strict reading 44/);
  assert.match(sweep('It runs **50** engines.'), /neither the index total/);
  for (const t of ['about **40** engines', 'runs **~40** engines', '~**40** engines', 'some **62** analytics engines', '**40+** engines']) {
    assert.match(sweep(t), /approximately/, t);
  }
  assert.match(sweep('**forty** engines'), /in words/);
});

test('the sweep refuses counts in words or behind a qualifier, and a sentence that puts every engine on one thread', () => {
  const sweep = (text: string) => lib.sweepEngineCounts([{ path: 'x.md', text }], SUMMARY, 40).problems.join('\n');
  for (const t of ['40-plus engines', 'some 40 engines', 'about 62 engines', 'over 40 engines', 'roughly 62 analytics engines', 'nearly 50 engines']) {
    assert.match(sweep(t), /approximately/, t);
  }
  for (const t of ['more than forty engines', 'sixty-two engines', 'forty engines']) assert.match(sweep(t), /in words/, t);
  // The engines as a whole, with or without a count, as the subject of a verb that places them.
  for (const t of [
    'All engines run in the analytics worker.',
    'every engine runs on the main thread',
    'Its engines run in a worker thread.',
    'Every engine runs in the analytics worker thread.',
    'All of the engines run on the main thread.',
    'The engines run\nin a background worker.',
    'All 62 engines run in the analytics worker.',
    'All 62 engines run on the main thread.',
    'The 62 engines run on the main thread.',
    'Its 62 engines all run in the analytics worker.',
    'The engines all run in the worker.',
    'All **62** engines run in the analytics worker.',
    'The engines are all in the worker.',
    'All engines run in the analytics worker, not the main thread.',
  ]) {
    assert.match(sweep(t), /the engines run on both threads/, t);
  }
  // The old wording, with a verb or a mark between.
  for (const t of ['engines in a worker thread', 'engines run in a worker thread', 'engines, in a worker thread', 'engines** in a worker thread']) {
    assert.match(sweep(t), /the engines run on both threads/, t);
  }
  // A subset, a split or a tag is not all of the engines on one thread.
  for (const t of [
    'the three write-capable engines',
    'Most engines that scan recorder history run in an analytics worker; the night-charge stack runs on the main thread.',
    'The engines fall into six groups (forecasting, battery and PV health, energy economics and arbitrage, alarms); most run in an analytics worker.',
    'The engines are listed.\n\nThe worker runs most of them.',
    'more than\n40 engines',
    'Its engines split between the analytics worker and the main thread.',
    'Of the engines, 27 run in the analytics worker and 35 on the main thread.',
    'The engines on the main thread include the night-charge stack.',
    'The engines in the index are tagged worker or main.',
    'The engines in the worker read history.',
    'the engines on the main thread are listed in the index',
    'The engines run on schedules; the worker sets none of them.',
  ]) {
    assert.equal(sweep(t), '', t);
  }
});

test('every surface states the same floor as the README', () => {
  const surfaces = (a: string, b: string) => [{ path: 'README.md', text: a }, { path: 'config.yaml', text: b }];
  const ok = lib.sweepEngineCounts(surfaces('**more than 40 engines**', 'built on\n  more than 40 engines: a plan'), SUMMARY, 40);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.floors, 2);
  const drift = lib.sweepEngineCounts(surfaces('**more than 40 engines**', 'more than 43 engines'), SUMMARY, 40).problems.join('\n');
  assert.match(drift, /config\.yaml:1: "more than 43 engines" differs from the README's floor, more than 40/);
  assert.match(lib.sweepEngineCounts(surfaces('**more than 41 engines**', 'more than 40 engines'), SUMMARY, 41).problems.join('\n'), /differs from the README's floor, more than 41/);
  assert.match(lib.sweepEngineCounts(surfaces('no floor', 'more than 40 engines'), SUMMARY, null).problems.join('\n'), /cannot be compared: the README states no floor/);
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
  const pages = lib.ENGINE_COUNT_SURFACE_DIRS.flatMap((dir) =>
    readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`));
  const sweep = lib.sweepEngineCounts([...lib.ENGINE_COUNT_SURFACES, ...pages].map((path) => ({ path, text: read(path) })), index.summary, readme.floor);
  assert.deepEqual(sweep.problems, []);
  assert.ok(sweep.floors >= 5, `expected the floor on the README, the add-on README, its config, the reference index and A.13; found ${sweep.floors}`);
});
