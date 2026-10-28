/**
 * engineIndex.mjs — parse and check the engine index, the census of the add-on's engines in
 * docs/reference/A-feature-inventory.md (section A.13), and every engine count the prose states.
 *
 * Why this exists. The README said "~40 analytics engines in a worker thread" for months. The
 * number was approximate, the thread was wrong for more than half of them, and nothing failed,
 * because a number in prose has no mechanism holding it to the code. The index makes the census
 * concrete: one row per engine, each naming a file and an identifier that the file declares only
 * while the engine exists. These checks hold the index to the source and the prose to the index:
 *
 *   - every row's file declares its identifier in code: a function, class, const, let, var,
 *     interface, type, enum or namespace of that name outside every comment and literal, so a
 *     rename that leaves the old name in comments, or a removal that leaves a caller, fails;
 *   - the rows are numbered 1..N without a gap, each engine and each file:identifier pair is unique,
 *     and status, thread, tier and group come from fixed vocabularies;
 *   - the index's own count sentence equals its rows: the total, the per-thread tallies and the
 *     strict reading (core rows that are neither advisory-only nor shadow);
 *   - the README's engine floor ("more than N engines") sits below the total and below the strict
 *     reading, so the prose never claims more than the index's strict reading;
 *   - each README group row states that group's tally;
 *   - on every surface swept (the fixed list below plus every page in the listed directories),
 *     each count written in digits before "engines" is the index total or a floor equal to the
 *     README's; a count with ~, ≈, a trailing + or "-plus", or a qualifier such as about, around,
 *     roughly, nearly, almost, approximately, some or over, fails, as does a count in words
 *     (twenty to ninety-nine) and a sentence that puts all of the engines (all, every, its or the
 *     engines) in the worker or on the main thread.
 *
 * Out of the tree, and so out of reach: the repository's About description on GitHub states the
 * floor too, and is changed by hand when the floor changes.
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
 * source line there. Every `*.md` page directly in ENGINE_COUNT_SURFACE_DIRS is added by the
 * caller from a directory listing; the frozen docs/history and the changelogs are not swept.
 */
export const ENGINE_COUNT_SURFACES = [
  'README.md',
  'ecoflow_panel/README.md',
  'ecoflow_panel/DOCS.md',
  'ecoflow_panel/config.yaml',
  'build.yaml',
  '.github/workflows/images.yml',
  'web/public/manifest.webmanifest',
];
/** Directories whose `*.md` pages the sweep reads: the operator guide and the engineering reference. */
export const ENGINE_COUNT_SURFACE_DIRS = ['docs/guide', 'docs/reference'];

/** `server/src/<path>.<ts|mts|mjs>:<identifier>` in backticks. */
const CODE_CELL = /^`(server\/src\/[\w./-]+\.(?:ts|mts|mjs)):([A-Za-z_$][\w$]*)`$/;
const TABLE_RULE = /^\|\s*:?-{3,}/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const unticked = (s) => s.replace(/^`|`$/g, '');

/** Keywords after which a `/` starts a regular-expression literal rather than a division. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * `text` (TypeScript or JavaScript source) with every comment and the contents of every string,
 * template and regular-expression literal replaced by spaces; line breaks are kept, so offsets
 * and line numbers hold. A template's `${…}` expressions stay code. The regular-expression test
 * is the usual previous-token heuristic: a `/` after an operand (an identifier that is not a
 * keyword, a number, `)` or `]`) is a division, anywhere else it opens a literal.
 */
export function codeOnly(text) {
  const out = [];
  const n = text.length;
  const keep = (k) => { out.push(text[k]); };
  const blank = (k) => { out.push(text[k] === '\n' ? '\n' : ' '); };
  const templates = []; // per open `${`, the depth of `{` inside it
  let prev = ''; // the last significant code character
  let word = ''; // the identifier or keyword that ends at `prev`
  let i = 0;
  /** Scan a template body from `i` (just past "`" or "}") to its closing "`" or its next "${". */
  const templateBody = () => {
    while (i < n) {
      if (text[i] === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
      if (text[i] === '`') { keep(i); i++; prev = ')'; word = ''; return; }
      if (text[i] === '$' && text[i + 1] === '{') { keep(i); keep(i + 1); i += 2; templates.push(0); prev = '{'; word = ''; return; }
      blank(i); i++;
    }
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close < 0 ? n : close + 2;
      while (i < stop) { blank(i); i++; }
      continue;
    }
    if (c === '\'' || c === '"') {
      keep(i); i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { blank(i); i++; }
        blank(i); i++;
      }
      if (i < n && text[i] === c) { keep(i); i++; }
      prev = ')'; word = '';
      continue;
    }
    if (c === '`') { keep(i); i++; templateBody(); continue; }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^}'.includes(prev) || REGEX_AFTER_WORD.has(word))) {
      keep(i); i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { blank(i); blank(i + 1); i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        blank(i); i++;
      }
      if (i < n && text[i] === '/') { keep(i); i++; }
      while (i < n && /[a-z]/.test(text[i])) { blank(i); i++; } // the flags
      prev = ')'; word = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(text[j])) j++;
      word = text.slice(i, j);
      for (; i < j; i++) keep(i);
      prev = word[word.length - 1];
      continue;
    }
    if (c === '{' && templates.length) templates[templates.length - 1]++;
    if (c === '}' && templates.length) {
      if (templates[templates.length - 1] === 0) { templates.pop(); keep(i); i++; templateBody(); continue; }
      templates[templates.length - 1]--;
    }
    // A `!` straight after an operand, not opening `!=`, is TypeScript's non-null assertion: the
    // expression is still an operand, so a `/` after it divides.
    const operand = /[\w$)\]]/.test(prev) && !REGEX_AFTER_WORD.has(word);
    const nonNull = c === '!' && operand && text[i + 1] !== '=';
    keep(i); i++;
    if (!/\s/.test(c)) { prev = /\d/.test(c) || nonNull ? ')' : c; word = ''; }
  }
  return out.join('');
}

/**
 * True when `text` declares `identifier` in code: a function (or generator), class, const, let,
 * var, interface, type alias, enum or namespace of exactly that name, outside every comment and
 * literal. A mention in a comment, a string or a call does not count, so a rename that leaves the
 * old name in comments, or a removal that leaves a caller behind, fails.
 */
export function declares(text, identifier) {
  const decl = new RegExp(
    `(?<![\\w$.])(?:function(?:\\s*\\*\\s*|\\s+)|(?:class|const|let|var|interface|type|enum|namespace)\\s+)${escapeRe(identifier)}(?![\\w$])`,
  );
  return decl.test(codeOnly(text));
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
    else if (!declares(src, ident)) {
      problems.push(`${who}: ${file} does not declare \`${ident}\` in code (a mention in a comment or a string does not count) — the engine was renamed or removed; fix the row`);
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

/**
 * The README's engine floor and its per-group rows, against the index summary. `floor` is the
 * number in the README's first "**more than N engines**" (null when there is none), the value every
 * other surface's floor must equal.
 */
export function checkReadmeEngineClaims(readme, summary) {
  const problems = [];
  const passes = [];
  const m = /\*\*more than (\d+) engines\*\*/.exec(readme);
  const floor = m ? Number(m[1]) : null;
  if (floor == null) {
    problems.push('engine floor GONE: README.md has no "**more than N engines**" claim');
  } else if (floor >= summary.total) {
    problems.push(`engine floor: README says more than ${floor}, the index holds ${summary.total}`);
  } else if (floor >= summary.strict) {
    problems.push(`engine floor: README says more than ${floor}, which is not below the strict reading ${summary.strict} (core rows that are neither advisory-only nor shadow)`);
  } else passes.push(`engine floor: more than ${floor} < strict ${summary.strict} ≤ ${summary.total} rows`);
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
  return { problems, passes, floor };
}

/** Tens written out, with an optional unit: "forty", "sixty-two", "forty two". */
const NUMBER_WORD = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';
/** Words that make the count after them approximate. "more than" is the floor, not one of these. */
const QUALIFIER = '(?:about|around|roughly|nearly|almost|approximately|some|over|upwards\\s+of|close\\s+to)';
/** A number of engines: an optional qualifier, ~ or ≈, digits or a written number, an optional + or -plus. */
const COUNT = new RegExp(
  `(?:\\b(${QUALIFIER})\\s+)?([~≈]\\s*)?(\\d[\\d,]*|\\b${NUMBER_WORD})(\\+|-plus)?\\s+(?:analytics\\s+)?engines\\b`,
  'gi',
);
/** The old wording, a number of engines "in a worker thread". */
const IN_A_WORKER = /engines\W{0,4}\s+in a worker thread/gi;
/**
 * All of the engines placed on one thread within 60 characters of one sentence, across a wrapped
 * line but not a blank one: "all engines … the worker", "its engines … main thread".
 */
const ALL_ON_ONE_THREAD = /\b(?:(?:all|its|the)\s+(?:of\s+(?:the|its)\s+)?(?:analytics\s+)?engines|every\s+(?:analytics\s+)?engine)\b(?:[^.\n]|\n(?![ \t]*\n)){0,60}?(?:\bworker\b|\bmain\s+thread\b)/gi;

/**
 * Every engine count on the given surfaces must be written in digits, as the index total or as a
 * floor ("more than N") equal to the README's `floor` and below the strict reading; never
 * approximate, never in words, and no sentence may put all of the engines on one thread.
 * `surfaces` is [{ path, text }], text null when the file is missing (itself a problem: a surface
 * that moved must be re-pointed here). `floor` null means the README states none, and then the
 * floors cannot be compared: that is a problem too.
 */
export function sweepEngineCounts(surfaces, summary, floor) {
  const problems = [];
  const floors = [];
  const lineOf = (text, i) => text.slice(0, i).split('\n').length;
  let seen = 0;
  for (const { path, text } of surfaces) {
    if (text == null) { problems.push(`${path} does not exist — re-point the engine-count sweep`); continue; }
    for (const m of text.matchAll(COUNT)) {
      seen++;
      const at = `${path}:${lineOf(text, m.index)}`;
      const said = m[0].trim();
      if (m[1] || m[2] || m[4]) {
        problems.push(`${at}: "${said}" states the engine count approximately; state the index total (${summary.total}) or the README's floor ("more than N engines")`);
        continue;
      }
      if (!/^\d/.test(m[3])) {
        problems.push(`${at}: "${said}" states the engine count in words; write it in digits, as the index total (${summary.total}) or the README's floor`);
        continue;
      }
      const n = Number(m[3].replace(/,/g, ''));
      const isFloor = /\bmore than\s+$/i.test(text.slice(Math.max(0, m.index - 20), m.index));
      if (!isFloor) {
        if (n !== summary.total) problems.push(`${at}: "${said}" is neither the index total (${summary.total}) nor a floor ("more than N engines")`);
        continue;
      }
      floors.push(n);
      if (n >= summary.strict) problems.push(`${at}: "more than ${n} engines" is not below the strict reading ${summary.strict}`);
      else if (floor != null && n !== floor) problems.push(`${at}: "more than ${n} engines" differs from the README's floor, more than ${floor}; every surface states the same floor`);
    }
    for (const re of [IN_A_WORKER, ALL_ON_ONE_THREAD]) {
      for (const m of text.matchAll(re)) {
        problems.push(`${path}:${lineOf(text, m.index)}: "${m[0]}" — the engines run on both threads; the index gives each one's thread`);
      }
    }
  }
  if (floor == null && floors.length) problems.push(`${floors.length} surface floor(s) cannot be compared: the README states no floor`);
  return { problems, counted: seen, floors: floors.length, surfaces: surfaces.length };
}
