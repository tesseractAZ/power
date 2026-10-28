#!/usr/bin/env node
/**
 * check-doc-claims.mjs — pin README.md's quantitative claims to the tree.
 *
 * Why this exists
 * ---------------
 * Every counted claim in README.md was measured once, written as prose, and then
 * silently rotted: "~2,380 tests" against 2,555, "18 harnesses" against 29,
 * "100+ anchors" against 201, "~9,100 lines" against 9,960, "CodeQL runs as
 * GitHub default setup, no workflow file" against a committed `codeql.yml`, and
 * a whole paragraph asserting GitHub's alert endpoints return empty on a private
 * repository — written when that was true, left standing after the repository
 * went public and both endpoints began returning real data.
 *
 * Not one of those failed anything. That is the point: a number in prose has no
 * mechanism holding it to the thing it describes, and this repository has now
 * learned that lesson more than once (`feedback_a_comment_is_not_a_mechanism`).
 * A "keep this in sync" comment is not a mechanism. A CI job is.
 *
 * The discipline this file follows
 * --------------------------------
 * A claim this script cannot evaluate is a FAILURE, never a quiet pass. The
 * codebase's recurring defect is silence that reads as health, and a doc checker
 * that skips what it cannot compute would be one more instance of it. There is
 * therefore no "skip" path: every claim below either verifies or fails loudly.
 *
 * The test count is exact or nothing. It cannot be derived statically (a scan of
 * `test(`/`it(` registrations reads 2,499 against a real 2,555 because some are
 * generated in loops), so it is passed in from the job that actually ran the
 * suite via `--tests N`. If it is absent the script runs the suite itself rather
 * than waiving the claim.
 *
 * The engine count follows the same rule. The README said "~40 analytics engines in a worker
 * thread": approximate, wrong about the thread for more than half of them, and held by nothing.
 * The engine index (docs/reference/A-feature-inventory.md, section A.13) is now the census, and
 * scripts/lib/engineIndex.mjs checks it: every row's identifier must occur in its file, the
 * index's count sentence must equal its rows, the README's floor ("more than N engines") must sit
 * below the strict reading the index discloses, each README group row must state its group's
 * tally, and no surface may state an engine count approximately.
 *
 * Usage:  node scripts/check-doc-claims.mjs [--tests N]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_INDEX_FILE,
  ENGINE_COUNT_SURFACES,
  checkEngineIndex,
  checkReadmeEngineClaims,
  sweepEngineCounts,
} from './lib/engineIndex.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(resolve(REPO, 'README.md'), 'utf8');

const failures = [];
const passes = [];

/** Assert a single claim. `actual` may be a number or a string. */
function claim(label, pattern, actual, { tolerance = 0 } = {}) {
  const m = README.match(pattern);
  if (!m) {
    failures.push(
      `${label}: the claim is GONE from README.md — pattern ${pattern} matched nothing. ` +
        `Either the sentence was reworded (update this pattern) or the claim was dropped ` +
        `(delete this check). An unfindable claim is not a passing one.`,
    );
    return;
  }
  const claimed = typeof actual === 'number' ? Number(m[1].replace(/[,~+]/g, '')) : m[1];
  if (typeof actual === 'number') {
    const slack = Math.ceil(Math.abs(actual) * tolerance);
    if (Math.abs(claimed - actual) > slack) {
      failures.push(
        `${label}: README says ${m[1]}, tree says ${actual}` +
          (slack ? ` (tolerance ±${slack})` : '') +
          `. Update the README sentence, not this check.`,
      );
      return;
    }
    passes.push(`${label}: ${m[1]} ≈ ${actual}${slack ? ` (±${slack})` : ''}`);
  } else {
    if (claimed !== actual) {
      failures.push(`${label}: README says "${claimed}", tree says "${actual}".`);
      return;
    }
    passes.push(`${label}: "${claimed}"`);
  }
}

// ---------------------------------------------------------------- harnesses
const harnesses = readdirSync(resolve(REPO, 'scripts')).filter(
  (f) => f.startsWith('mutate-') && f.endsWith('.mjs'),
).length;
claim('mutation harnesses', /\*\*(\d+) harnesses\*\*/, harnesses);

// ------------------------------------------------------------------ anchors
// The anchor checker is the authority on its own count; parse its summary line
// rather than re-deriving it here, so the two can never disagree.
let anchors = null;
try {
  const out = execFileSync('node', [resolve(REPO, 'scripts/check-mutant-anchors.mjs')], {
    cwd: REPO,
    encoding: 'utf8',
  });
  const m = out.match(/(\d+)\/(\d+) mutant anchors resolve across (\d+) harnesses/);
  if (m) {
    anchors = Number(m[2]);
    if (Number(m[3]) !== harnesses) {
      failures.push(
        `anchor checker counted ${m[3]} harnesses, this script counted ${harnesses} — ` +
          `the two disagree about the same directory.`,
      );
    }
  }
} catch (e) {
  failures.push(`could not run check-mutant-anchors.mjs to obtain the anchor count: ${e.message}`);
}
if (anchors == null) {
  failures.push('anchor count UNAVAILABLE — the checker ran but its summary line did not parse.');
} else {
  claim('anchor-asserted mutants', /\*\*(\d+)\s*\n?anchor-asserted mutants\*\*/, anchors);
}

// ------------------------------------------------- engineering reference size
// v1.188.0 — the manual is the engineering reference in docs/reference/: one file per chapter or
// part, listed by the index (README.md there, which is not counted). ecoflow_panel/DOCS.md is now
// the operator guide, held to its own size by check-docs.mjs. The README states the reference's
// total line count (within 3 %) and its exact file count, in one parenthesis that a line break
// and a blockquote marker may split.
const REFERENCE_DIR = resolve(REPO, 'docs/reference');
const referenceFiles = readdirSync(REFERENCE_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
  .map((e) => e.name);
const referenceLines = referenceFiles.reduce(
  (n, f) => n + readFileSync(resolve(REFERENCE_DIR, f), 'utf8').split('\n').length, 0);
claim('engineering reference line count', /\(~([\d,]+)[\s>]*lines in\b/, referenceLines, { tolerance: 0.03 });
claim('engineering reference file count', /\blines in[\s>]*(\d+)[\s>]*reference files\)/, referenceFiles.length);

// --------------------------------------------------------- workflow roster
// The README's repository-layout table names every workflow. A workflow added or
// removed without touching that row is the exact drift that let the README claim
// CodeQL had no workflow file while codeql.yml sat in the tree.
const wfDir = resolve(REPO, '.github/workflows');
const workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort();
const layoutRow = README.split('\n').find((l) => l.includes('.github/workflows/'));
if (!layoutRow) {
  failures.push('repository-layout table has no `.github/workflows/` row.');
} else {
  const missing = workflows.filter((w) => !layoutRow.includes(w));
  const phantom = [...layoutRow.matchAll(/`([a-z0-9-]+\.ya?ml)`/g)]
    .map((m) => m[1])
    .filter((w) => !workflows.includes(w));
  if (missing.length) failures.push(`workflows in the tree but not named in the README row: ${missing.join(', ')}`);
  if (phantom.length) failures.push(`workflows named in the README row but absent from the tree: ${phantom.join(', ')}`);
  if (!missing.length && !phantom.length) passes.push(`workflow roster: ${workflows.length} files, all named`);
}

// ------------------------------------------------------------- engine index
// The census of engines and every engine count in prose. A file is read once; a missing one is a
// caught ENOENT, never an existence probe first (this repository's CodeQL rule).
const readOrNull = (rel) => {
  try {
    return readFileSync(resolve(REPO, rel), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
};
const indexText = readOrNull(ENGINE_INDEX_FILE);
if (indexText == null) {
  failures.push(`engine index UNVERIFIABLE: ${ENGINE_INDEX_FILE} does not exist.`);
} else {
  const sourceCache = new Map();
  const readSource = (rel) => {
    if (!sourceCache.has(rel)) sourceCache.set(rel, readOrNull(rel));
    return sourceCache.get(rel);
  };
  const index = checkEngineIndex(indexText, readSource);
  for (const p of index.problems) failures.push(`engine index: ${p}`);
  if (index.summary == null) {
    failures.push('engine floor, group counts and count wording UNVERIFIABLE: the engine index could not be read.');
  } else {
    const s = index.summary;
    if (!index.problems.length) {
      passes.push(
        `engine index: ${s.total} rows, every anchor resolves in ${sourceCache.size} source files; ` +
          `${s.worker} worker / ${s.main} main${s.both ? ` / ${s.both} both` : ''}; strict reading ${s.strict}`,
      );
    }
    const readme = checkReadmeEngineClaims(README, s);
    failures.push(...readme.problems);
    passes.push(...readme.passes);
    const guideDir = 'docs/guide';
    const guidePages = readdirSync(resolve(REPO, guideDir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${guideDir}/${e.name}`)
      .sort();
    const surfaces = [...ENGINE_COUNT_SURFACES, ...guidePages].map((path) => ({ path, text: readOrNull(path) }));
    const sweep = sweepEngineCounts(surfaces, s);
    failures.push(...sweep.problems);
    if (!sweep.problems.length) {
      passes.push(`engine-count wording: ${sweep.counted} count(s) across ${sweep.surfaces} surfaces, none approximate or stale`);
    }
  }
}

// -------------------------------------------------------------- test count
// Exact or nothing. `--tests N` comes from the job that ran the suite; without
// it we run the suite here rather than waive the claim.
const argIdx = process.argv.indexOf('--tests');
let tests = argIdx > -1 ? Number(process.argv[argIdx + 1]) : null;
if (tests != null && !Number.isFinite(tests)) {
  failures.push(`--tests was given a non-numeric value: ${process.argv[argIdx + 1]}`);
  tests = null;
} else if (tests == null) {
  const server = resolve(REPO, 'server');
  if (!existsSync(resolve(server, 'node_modules'))) {
    failures.push(
      'test count UNVERIFIABLE: --tests was not supplied and server/node_modules is absent, ' +
        'so the suite cannot be run to obtain it. Pass --tests N from the job that ran it.',
    );
  } else {
    try {
      const out = execFileSync('npm', ['test'], { cwd: server, encoding: 'utf8', stdio: 'pipe' });
      const m = out.match(/^\s*ℹ?\s*pass\s+(\d+)/m);
      if (m) tests = Number(m[1]);
      else failures.push('test count UNVERIFIABLE: ran the suite but could not parse its "pass N" line.');
    } catch (e) {
      const out = `${e.stdout ?? ''}`;
      const m = out.match(/^\s*ℹ?\s*pass\s+(\d+)/m);
      if (m) {
        tests = Number(m[1]);
        failures.push('the test suite did not exit clean; the count below is from a RED tree.');
      } else {
        failures.push(`test count UNVERIFIABLE: running the suite failed: ${e.message}`);
      }
    }
  }
}
if (tests != null) claim('test count', /#\s*([\d,]+) tests/, tests);

// ------------------------------------------------------------------ report
for (const p of passes) console.log(`  ok    ${p}`);
if (failures.length) {
  console.error(`\n${failures.length} README claim(s) no longer match the tree:\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(
    '\nThese are claims a reader is entitled to trust. Fix the sentence in README.md,\n' +
      'or, if the claim is genuinely obsolete, remove both the sentence and its check.\n',
  );
  process.exit(1);
}
console.log(`\n${passes.length}/${passes.length} README claims match the tree.`);
