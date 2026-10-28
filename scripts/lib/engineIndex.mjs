/**
 * engineIndex.mjs — parse and check the engine index, the census of the add-on's engines in
 * docs/reference/A-feature-inventory.md (section A.13), and every engine count the prose states.
 *
 * Why this exists. The README said "~40 analytics engines in a worker thread" for months. The
 * number was approximate, the thread was wrong for more than half of them, and nothing failed,
 * because a number in prose has no mechanism holding it to the code. The index makes the census
 * concrete: one row per engine, each naming a file and an identifier that occurs in it only while
 * the engine exists. These checks hold the index to the source and the prose to the index:
 *
 *   - every row's identifier occurs as a whole word in its file (a renamed or removed engine fails);
 *   - the rows are numbered 1..N without a gap, each engine and each file:identifier pair is unique,
 *     and status, thread, tier and group come from fixed vocabularies;
 *   - the index's own count sentence equals its rows: the total, the per-thread tallies and the
 *     strict reading (core rows that are neither advisory-only nor shadow);
 *   - the README's engine floor ("more than N engines") sits below the total and below the strict
 *     reading, so the prose can never claim more than the strictest reading the index discloses;
 *   - each README group row states that group's tally;
 *   - no surface states an engine count approximately (~, ≈, a trailing +), a count other than the
 *     index total or a floor below the strict reading, or places the engines "in a worker thread".
 *
 * Every function here is pure: it takes text (and, for the anchors, a reader) and returns
 * problems. scripts/check-doc-claims.mjs does the file access and the reporting, in CI;
 * server/test/engineIndex.test.ts runs the fixtures that prove each check can fail. A check that
 * cannot be evaluated is a problem, never a pass: there is no skip path.
 */

export const ENGINE_INDEX_FILE = 'docs/reference/A-feature-inventory.md';
export const ENGINE_INDEX_HEADING = '### A.13 Engine index';
export const ENGINE_STATUSES = ['live', 'live-opt-in', 'advisory-only', 'shadow', 'write-capable-gated'];
export const ENGINE_THREADS = ['worker', 'main', 'both'];
export const ENGINE_TIERS = ['core', 'borderline'];
export const ENGINE_GROUPS = [
  'Forecasting',
  'Battery & PV health',
  'Energy economics & arbitrage',
  'Alarms & safety',
  'Learning & anomaly detection',
  'Telemetry integrity',
];
/** Statuses the strict reading drops: computed and published, never acted on. */
export const NON_ACTING_STATUSES = ['advisory-only', 'shadow'];
/** Columns the checks read; a table may carry more, mapped by name. */
export const REQUIRED_COLUMNS = ['#', 'Engine', 'Status', 'Thread', 'Tier', 'Code', 'Output'];
/**
 * Every in-tree surface that states, or used to state, how many engines the add-on runs. The
 * config description and the image labels are read as raw text, so a floor must stay on one
 * source line there. docs/guide/*.md is added by the caller from a directory listing.
 */
export const ENGINE_COUNT_SURFACES = [
  'README.md',
  'docs/reference/README.md',
  'ecoflow_panel/README.md',
  'ecoflow_panel/DOCS.md',
  'ecoflow_panel/config.yaml',
  'build.yaml',
  '.github/workflows/images.yml',
  'web/public/manifest.webmanifest',
];

/** `server/src/<path>.<ts|mts|mjs>:<identifier>` in backticks. */
const CODE_CELL = /^`(server\/src\/[\w./-]+\.(?:ts|mts|mjs)):([A-Za-z_$][\w$]*)`$/;
const TABLE_RULE = /^\|\s*:?-{3,}/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const unticked = (s) => s.replace(/^`|`$/g, '');

/** True when `identifier` occurs in `text` as a whole word (not as part of a longer identifier). */
export function occursAsWord(text, identifier) {
  return new RegExp(`(?<![\\w$])${escapeRe(identifier)}(?![\\w$])`).test(text);
}

/**
 * Parse the index section of `text` (the whole A-feature-inventory.md). Returns the rows, the
 * numbers the count sentences state (null when a sentence is absent), and structural problems.
 * `rows` is null only when the section itself is missing.
 */
export function parseEngineIndex(text) {
  const problems = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === ENGINE_INDEX_HEADING);
  if (start < 0) {
    return {
      rows: null,
      stated: null,
      problems: [`engine index GONE: no "${ENGINE_INDEX_HEADING}" heading in ${ENGINE_INDEX_FILE}`],
    };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i])) { end = i; break; }
  }

  const rows = [];
  const prose = [];
  const groupsSeen = [];
  let group = null;
  let header = null; // { cols: Map<name, index>, width }
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const h4 = /^####\s+(.+?)\s*$/.exec(line);
    if (h4) {
      group = h4[1];
      header = null;
      if (!ENGINE_GROUPS.includes(group)) problems.push(`line ${lineNo}: unknown group "${group}" (known: ${ENGINE_GROUPS.join(', ')})`);
      else if (groupsSeen.includes(group)) problems.push(`line ${lineNo}: group "${group}" appears twice`);
      groupsSeen.push(group);
      continue;
    }
    if (!line.trimStart().startsWith('|')) {
      header = null;
      prose.push(line);
      continue;
    }
    if (header == null) {
      if (!TABLE_RULE.test(lines[i + 1] ?? '')) {
        problems.push(`line ${lineNo}: a table row with no header above it`);
        continue;
      }
      const names = cells(line);
      const cols = new Map(names.map((n, k) => [n, k]));
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c));
      if (missing.length) problems.push(`line ${lineNo}: table header lacks column(s) ${missing.join(', ')}`);
      if (group == null) problems.push(`line ${lineNo}: a table before any "#### <group>" heading`);
      header = { cols, width: names.length, ok: missing.length === 0 };
      i++; // the rule line
      continue;
    }
    const c = cells(line);
    if (c.length !== header.width) {
      problems.push(`line ${lineNo}: ${c.length} cells where the header has ${header.width} (a stray or missing "|")`);
      continue;
    }
    if (!header.ok) continue;
    const get = (name) => c[header.cols.get(name)];
    rows.push({
      line: lineNo,
      group,
      num: get('#'),
      engine: get('Engine'),
      status: unticked(get('Status')),
      thread: unticked(get('Thread')),
      tier: unticked(get('Tier')),
      code: get('Code'),
    });
  }
  for (const g of ENGINE_GROUPS) {
    if (!groupsSeen.includes(g)) problems.push(`group "${g}" is missing from the index`);
    else if (!rows.some((r) => r.group === g)) problems.push(`group "${g}" has no rows`);
  }

  const text2 = prose.join('\n');
  const num = (re) => { const m = re.exec(text2); return m ? Number(m[1]) : null; };
  const stated = {
    total: num(/\*\*(\d+) engines\*\*/),
    worker: num(/\*\*(\d+)\*\* in the analytics worker/),
    main: num(/\*\*(\d+)\*\* on the main thread/),
    both: num(/\*\*(\d+)\*\* on both/),
    strict: num(/holds \*\*(\d+)\*\*/),
  };
  return { rows, stated, problems };
}

/**
 * Check the index against itself and the source. `readSource(path)` returns the file's text, or
 * null when it does not exist (the caller catches ENOENT; it never probes first). Returns the
 * problems and, whenever the rows could be read, a summary of the tallies.
 */
export function checkEngineIndex(text, readSource) {
  const parsed = parseEngineIndex(text);
  const problems = [...parsed.problems];
  if (parsed.rows == null) return { problems, summary: null };
  const { rows, stated } = parsed;
  if (rows.length === 0) problems.push('the engine index has no rows');

  const names = new Set();
  const pairs = new Set();
  const sources = new Map();
  rows.forEach((r, k) => {
    const who = `row ${r.num} ${r.engine || '(unnamed)'}`;
    if (r.num !== String(k + 1)) problems.push(`${who} (line ${r.line}): numbered "${r.num}", expected ${k + 1} — the rows run 1..N without a gap`);
    if (!r.engine) problems.push(`row ${r.num} (line ${r.line}): the Engine cell is empty`);
    else if (names.has(r.engine)) problems.push(`${who}: the engine name appears twice`);
    names.add(r.engine);
    if (!ENGINE_STATUSES.includes(r.status)) problems.push(`${who}: unknown status "${r.status}" (known: ${ENGINE_STATUSES.join(', ')})`);
    if (!ENGINE_THREADS.includes(r.thread)) problems.push(`${who}: unknown thread "${r.thread}" (known: ${ENGINE_THREADS.join(', ')})`);
    if (!ENGINE_TIERS.includes(r.tier)) problems.push(`${who}: unknown tier "${r.tier}" (known: ${ENGINE_TIERS.join(', ')})`);
    const m = CODE_CELL.exec(r.code);
    if (!m || m[1].split('/').includes('..')) {
      problems.push(`${who}: Code cell ${r.code || '(empty)'} is not \`server/src/<file>.ts:<identifier>\``);
      return;
    }
    const [, file, ident] = m;
    if (pairs.has(`${file}:${ident}`)) problems.push(`${who}: \`${file}:${ident}\` anchors another row too`);
    pairs.add(`${file}:${ident}`);
    if (!sources.has(file)) sources.set(file, readSource(file));
    const src = sources.get(file);
    if (src == null) problems.push(`${who}: ${file} does not exist — the engine was moved or removed; fix the row`);
    else if (!occursAsWord(src, ident)) {
      problems.push(`${who}: \`${ident}\` does not occur in ${file} — the engine was renamed or removed; fix the row`);
    }
  });

  const count = (pred) => rows.filter(pred).length;
  const summary = {
    total: rows.length,
    worker: count((r) => r.thread === 'worker'),
    main: count((r) => r.thread === 'main'),
    both: count((r) => r.thread === 'both'),
    strict: count((r) => r.tier === 'core' && !NON_ACTING_STATUSES.includes(r.status)),
    groups: Object.fromEntries(ENGINE_GROUPS.map((g) => [g, count((r) => r.group === g)])),
  };
  const sentence = (label, claimed, actual) => {
    if (claimed == null) problems.push(`the index's count sentence no longer states "${label}" — it must state ${actual}`);
    else if (claimed !== actual) problems.push(`the index's count sentence says ${claimed} for "${label}"; its rows give ${actual}`);
  };
  sentence('**N engines**', stated.total, summary.total);
  sentence('**N** in the analytics worker', stated.worker, summary.worker);
  sentence('**N** on the main thread', stated.main, summary.main);
  if (summary.both > 0) sentence('**N** on both', stated.both, summary.both);
  else if (stated.both != null && stated.both !== 0) problems.push(`the index's count sentence says ${stated.both} on both, but no row runs on both`);
  sentence('holds **N**', stated.strict, summary.strict);
  return { problems, summary };
}

/** The README's engine floor and its per-group rows, against the index summary. */
export function checkReadmeEngineClaims(readme, summary) {
  const problems = [];
  const passes = [];
  const floor = /\*\*more than (\d+) engines\*\*/.exec(readme);
  if (!floor) {
    problems.push('engine floor GONE: README.md has no "**more than N engines**" claim');
  } else {
    const n = Number(floor[1]);
    if (n >= summary.total) problems.push(`engine floor: README says more than ${n}, the index holds ${summary.total}`);
    else if (n >= summary.strict) {
      problems.push(`engine floor: README says more than ${n}, which is not below the strict reading ${summary.strict} (core rows that are neither advisory-only nor shadow)`);
    } else passes.push(`engine floor: more than ${n} < strict ${summary.strict} ≤ ${summary.total} rows`);
  }
  const stated = [];
  for (const g of ENGINE_GROUPS) {
    const found = [...readme.matchAll(new RegExp(`^\\|\\s*${escapeRe(g)}\\s*\\|\\s*(\\d+)\\s*\\|`, 'gm'))];
    if (found.length !== 1) {
      problems.push(`engine groups: README.md has ${found.length} "| ${g} | N |" rows, expected 1`);
      continue;
    }
    const n = Number(found[0][1]);
    if (n !== summary.groups[g]) problems.push(`engine groups: README says ${g} has ${n}, the index has ${summary.groups[g]}`);
    else stated.push(n);
  }
  if (stated.length === ENGINE_GROUPS.length) passes.push(`engine groups: ${stated.join('/')} match the index`);
  return { problems, passes };
}

/**
 * Every "N engines" on the given surfaces must be the index total, or a floor ("more than N")
 * below the strict reading; never approximate. `surfaces` is [{ path, text }], text null when the
 * file is missing (itself a problem: a surface that moved must be re-pointed here).
 */
export function sweepEngineCounts(surfaces, summary) {
  const problems = [];
  const COUNT = /([~≈]\s*)?(\d[\d,]*)(\+?)\s+(?:analytics\s+)?engines\b/gi;
  const WORKER = /engines\W{0,4}\s+in a worker thread/gi;
  const lineOf = (text, i) => text.slice(0, i).split('\n').length;
  let seen = 0;
  for (const { path, text } of surfaces) {
    if (text == null) { problems.push(`${path} does not exist — re-point the engine-count sweep`); continue; }
    for (const m of text.matchAll(COUNT)) {
      seen++;
      const at = `${path}:${lineOf(text, m.index)}`;
      const n = Number(m[2].replace(/,/g, ''));
      if (m[1] || m[3]) {
        problems.push(`${at}: "${m[0].trim()}" states the engine count approximately; state the index total (${summary.total}) or a floor ("more than N", N < ${summary.strict})`);
        continue;
      }
      const floor = /\bmore than\s+$/i.test(text.slice(Math.max(0, m.index - 20), m.index));
      if (floor && n >= summary.strict) problems.push(`${at}: "more than ${n} engines" is not below the strict reading ${summary.strict}`);
      if (!floor && n !== summary.total) problems.push(`${at}: "${m[0].trim()}" is neither the index total (${summary.total}) nor a floor below the strict reading`);
    }
    for (const m of text.matchAll(WORKER)) {
      problems.push(`${path}:${lineOf(text, m.index)}: "${m[0]}" — engines run on both threads; the index gives each one's thread`);
    }
  }
  return { problems, counted: seen, surfaces: surfaces.length };
}
