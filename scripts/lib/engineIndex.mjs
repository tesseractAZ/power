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
 *   - every row's file declares its identifier in code: a function, class, interface, type, enum
 *     or namespace of that name, or the first name a const, let or var declares, outside every
 *     comment and literal, so a rename that leaves the old name in comments, or a removal that
 *     leaves a caller, fails;
 *   - every row has the header's cell count, a pipe inside a cell written as \|; a row that does
 *     not is a problem, and while one is dropped the numbering and count-sentence checks wait;
 *   - the rows are numbered 1..N without a gap, each engine and each file:identifier pair is unique,
 *     and status, thread, tier and group come from fixed vocabularies;
 *   - the index's own count sentence equals its rows: the total, the per-thread tallies, the strict
 *     reading (core rows that are neither advisory-only nor shadow), "Of those, N are live" (core
 *     rows with status live) and "the other N wait" (the rest of the strict reading);
 *   - the README's engine floor ("more than N engines") sits below the total and below the strict
 *     reading, so the prose never claims more than the index's strict reading;
 *   - each README group row states that group's tally, and every "N write-capable engines" in the
 *     README (digits, or a word from zero to twelve; at least one is required) equals the
 *     write-capable-gated rows;
 *   - on every surface swept (the fixed list below plus every page in the listed directories), a
 *     count written directly before "engines" or "analytics engines", plain or in Markdown
 *     emphasis (one to three * or _), must be in digits and be the index total or a floor ("more
 *     than N") equal to the README's; such a count with ~ or ≈, a trailing + or "-plus", or after
 *     one of the qualifiers about, around, roughly, nearly, almost, approximately, some, over,
 *     upwards of or close to fails, as does one written in words from twenty to ninety-nine. Any
 *     other count (elsewhere in a sentence, or a word outside that range: "two engines") is not
 *     read (COUNT);
 *   - on the same surfaces, "engines in a worker thread" fails, also with run, runs or running, or
 *     up to four marks such as a comma, between (IN_A_WORKER);
 *   - so does a sentence that makes the engines as a whole (all, all of the, all the, every, its or
 *     the engines, with or without a count in digits) the subject of run, live, sit, reside or
 *     execute, or of is or are followed by in, on, run, hosted, computed or executed, and names the
 *     worker or the main thread within the next 60 characters (ALL_ON_ONE_THREAD); and one that
 *     makes them, or a count of them, the object of run, host, execute, put, place or keep (not
 *     after "not", "never" or "n't") followed directly by in or on the worker or the main thread
 *     (OBJECT_ON_ONE_THREAD). Neither reads a subject after "of", "not" or "not all" ("27 of the
 *     engines", "not all engines"), a window that reaches "both" or "either" before a thread, or a
 *     thread followed within 40 characters by "and" or "or" and a thread ("in the worker and on
 *     the main thread"); a narrowed subject ("the engines on the main thread include …") or another
 *     verb ("its engines split between …") does not match.
 *
 * Out of the tree, and so out of reach: the repository's About description on GitHub states the
 * floor too, and is changed by hand when the floor changes.
 *
 * Every function here is pure: it takes text (and, for the anchors, a reader) and returns
 * problems. scripts/check-doc-claims.mjs does the file access and the reporting, in CI;
 * server/test/engineIndex.test.ts runs the fixtures that prove each check can fail. A check that
 * cannot be evaluated is a problem, never a pass: a check that waits on a row that did not parse
 * leaves that row's problem standing, so the run still fails.
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
/**
 * A table row's cells, split the way GitHub's table extension splits them: on every `|` that no
 * backslash escapes (a backslash escapes the character after it, so `\\|` ends a cell), with the
 * outer border pipes dropped and `\|` unescaped to `|` inside a cell.
 */
const cells = (line) => {
  const out = [''];
  const t = line.trim();
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && k + 1 < t.length) { out[out.length - 1] += t[k] + t[k + 1]; k++; continue; }
    if (t[k] === '|') { out.push(''); continue; }
    out[out.length - 1] += t[k];
  }
  if (t.startsWith('|')) out.shift();
  if (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out.map((c) => c.trim().replace(/\\\|/g, '|'));
};
const unticked = (s) => s.replace(/^`|`$/g, '');

/** Keywords after which a `/` starts a regular-expression literal rather than a division. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'default', 'do', 'else', 'yield', 'await',
]);
/** The characters that start and continue an identifier, Unicode letters included. */
const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

/**
 * `text` (TypeScript or JavaScript source) with every comment and the contents of every string,
 * template and regular-expression literal replaced by spaces; line breaks are kept, so offsets
 * and line numbers hold. A template's `${…}` expressions stay code. The regular-expression test
 * is the usual previous-token heuristic: a `/` after an operand (an identifier that is not a
 * keyword, a keyword used as a property name after `.`, `?.` or a private name's `#`, `of` used
 * as a variable name, a number, `)`, `]`, a non-null `!` or a postfix `++`/`--`) is a division,
 * anywhere else it opens a literal, so a literal straight after `if (…)` or `while (…)` reads as
 * a division. JSX is not lexed: a closing tag reads as a literal and a text child as code, which
 * is why CODE_CELL anchors only `.ts`, `.mts` and `.mjs` files.
 */
export function codeOnly(text) {
  const out = [];
  const n = text.length;
  const keep = (k) => { out.push(text[k]); };
  const blank = (k) => { out.push(text[k] === '\n' ? '\n' : ' '); };
  /** The code point at `k`, as a string of one or two UTF-16 units. */
  const at = (k) => String.fromCodePoint(text.codePointAt(k));
  const templates = []; // per open `${`, the depth of `{` inside it
  let prev = ''; // the last significant code character; 'a' stands for the end of any identifier
  let word = ''; // the identifier or keyword that ends at `prev`; '' for a property name or anything else
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
    const cp = at(i);
    if (ID_START.test(cp)) {
      let j = i + cp.length;
      while (j < n) {
        const part = at(j);
        if (!ID_PART.test(part)) break;
        j += part.length;
      }
      const ident = text.slice(i, j);
      // After `.`, `?.` or a private name's `#` a keyword is a property name, so the expression is
      // an operand: `kwh.in / 2`, `pv.yield / 2` and `this.#in / 2` divide. `of` is the for-of
      // keyword only straight after the loop's binding (an identifier, `]` or `}`); anywhere else
      // it is a variable name, and `of / 2` divides.
      const property = prev === '.' || prev === '#';
      const ofIsName = ident === 'of' && !(/[\w$\]}]/.test(prev) && !REGEX_AFTER_WORD.has(word));
      word = property || ofIsName ? '' : ident;
      for (; i < j; i++) keep(i);
      prev = 'a';
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
    // A `++` or `--` straight after an operand is postfix: the expression is still an operand, so
    // `n++ / 2` divides.
    if ((c === '+' || c === '-') && d === c && operand) {
      keep(i); keep(i + 1); i += 2;
      prev = ')'; word = '';
      continue;
    }
    const nonNull = c === '!' && operand && text[i + 1] !== '=';
    keep(i); i++;
    if (!/\s/.test(c)) { prev = /\d/.test(c) || nonNull ? ')' : c; word = ''; }
  }
  return out.join('');
}

/**
 * True when `text` declares `identifier` in code: a function (or generator), class, interface,
 * type alias, enum or namespace of exactly that name, or the first name a const, let or var
 * declares, outside every comment and literal. A mention in a comment, a string or a call does
 * not count, so a rename that leaves the old name in comments, or a removal that leaves a caller
 * behind, fails. A later declarator (`sxx` in `let sy = 0, sxx = 0`) or a destructured name is not
 * read: such an anchor fails, and the row names another identifier.
 */
export function declares(text, identifier) {
  const decl = new RegExp(
    `(?<![\\w$.])(?:function(?:\\s*\\*\\s*|\\s+)|(?:class|const|let|var|interface|type|enum|namespace)\\s+)${escapeRe(identifier)}(?![\\w$])`,
  );
  return decl.test(codeOnly(text));
}

/**
 * Parse the index section of `text` (the whole A-feature-inventory.md). Returns the rows, the
 * numbers the count sentences state (null when a sentence is absent), structural problems, and
 * `rejected`, the number of rows dropped for a cell count that differs from the header's.
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
      rejected: 0,
      problems: [`engine index GONE: no "${ENGINE_INDEX_HEADING}" heading in ${ENGINE_INDEX_FILE}`],
    };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i])) { end = i; break; }
  }

  const rows = [];
  const prose = [];
  let rejected = 0;
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
      rejected++;
      problems.push(
        `line ${lineNo}: ${c.length} cells where the header has ${header.width} (a stray or missing "|"; write a pipe inside a cell as \\|) — ` +
          'the row is dropped, and the numbering and count-sentence checks wait until every row parses',
      );
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
    live: num(/Of those, (\d+) are live\b/),
    waiting: num(/the other (\d+) wait\b/),
  };
  return { rows, stated, problems, rejected };
}

/**
 * Check the index against itself and the source. `readSource(path)` returns the file's text, or
 * null when it does not exist (the caller catches ENOENT; it never probes first). Returns the
 * problems and, whenever the rows could be read, a summary of the tallies. A row dropped for its
 * cell count is a problem of its own, and while one is dropped the numbering and the count
 * sentence are not compared: every later row would read as misnumbered and every tally one short,
 * burying the cause. The summary then carries `rejected` > 0, and its tallies are partial.
 */
export function checkEngineIndex(text, readSource) {
  const parsed = parseEngineIndex(text);
  const problems = [...parsed.problems];
  if (parsed.rows == null) return { problems, summary: null };
  const { rows, stated, rejected } = parsed;
  if (rows.length === 0) problems.push('the engine index has no rows');

  const names = new Set();
  const pairs = new Set();
  const sources = new Map();
  rows.forEach((r, k) => {
    const who = `row ${r.num} ${r.engine || '(unnamed)'}`;
    if (!rejected && r.num !== String(k + 1)) problems.push(`${who} (line ${r.line}): numbered "${r.num}", expected ${k + 1} — the rows run 1..N without a gap`);
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
    live: count((r) => r.tier === 'core' && r.status === 'live'),
    gated: count((r) => r.status === 'write-capable-gated'),
    groups: Object.fromEntries(ENGINE_GROUPS.map((g) => [g, count((r) => r.group === g)])),
    rejected,
  };
  if (rejected) return { problems, summary };
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
  sentence('Of those, N are live', stated.live, summary.live);
  sentence('the other N wait', stated.waiting, summary.strict - summary.live);
  return { problems, summary };
}

/** Zero to twelve written out; the index of a word is its value. */
const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** The README's count of write-capable engines, in digits or as a word from zero to twelve. */
const WRITE_CAPABLE = new RegExp(`\\b(\\d+|${SMALL_NUMBER_WORDS.join('|')})\\s+write-capable\\s+engines?\\b`, 'gi');

/**
 * The README's engine floor, its per-group rows and its count of write-capable engines, against the
 * index summary. `floor` is the number in the README's first "**more than N engines**" (null when
 * there is none), the value every other surface's floor must equal. Every "N write-capable engines"
 * must equal the index's write-capable-gated rows, and at least one must be present.
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
  const gated = [...readme.matchAll(WRITE_CAPABLE)];
  if (gated.length === 0) {
    problems.push('write-capable count GONE: README.md has no "N write-capable engines" claim');
  }
  for (const m of gated) {
    const said = m[1].toLowerCase();
    const n = /^\d+$/.test(said) ? Number(said) : SMALL_NUMBER_WORDS.indexOf(said);
    if (n !== summary.gated) {
      problems.push(`write-capable count: README says "${m[0]}", the index has ${summary.gated} write-capable-gated row(s)`);
    }
  }
  if (gated.length && !problems.some((p) => p.startsWith('write-capable count'))) {
    passes.push(`write-capable count: ${summary.gated} write-capable-gated row(s), as the README states`);
  }
  return { problems, passes, floor };
}

/** Tens written out, with an optional unit: "forty", "sixty-two", "forty two". */
const NUMBER_WORD = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';
/** Words that make the count after them approximate. "more than" is the floor, not one of these. */
const QUALIFIER = '(?:about|around|roughly|nearly|almost|approximately|some|over|upwards\\s+of|close\\s+to)';
/** Optional Markdown emphasis: one to three `*` or `_` (italic, bold, or both). */
const EM = '(?:\\*{1,3}|_{1,3})?';
/** A word start that `\b` misses after `_` emphasis ("__about__"): no letter or digit before it. */
const WB = '(?<![A-Za-z\\d])';
/**
 * A number of engines, written directly before "engines" or "analytics engines": an optional
 * qualifier, ~ or ≈, digits or a written number from twenty to ninety-nine, an optional + or
 * -plus, with emphasis allowed after the qualifier, around the ~, the number and the suffix, and
 * before either noun ("about **40** engines", "**40**+ engines", "more than ***50*** engines",
 * "61 **engines**"). A count anywhere else in the sentence is not read.
 */
const COUNT = new RegExp(
  `(?:${WB}(${QUALIFIER})${EM}\\s+)?${EM}([~≈]\\s*)?${EM}(\\d[\\d,]*|${WB}${NUMBER_WORD})${EM}(\\+|-plus)?${EM}` +
    `\\s+${EM}(?:analytics${EM}\\s+${EM})?engines(?![A-Za-z\\d])`,
  'gi',
);
/** A floor: "more than" (emphasis allowed around it), then the count COUNT matched. */
const FLOOR_BEFORE = new RegExp(`${WB}more\\s+than${EM}\\s+${EM}$`, 'i');
/**
 * The old wording: "engines in a worker thread", with "run", "runs" or "running", or up to four
 * marks such as a comma or `**`, between.
 */
const IN_A_WORKER = /engines\W{0,4}\s+(?:run(?:s|ning)?\s+)?in a worker thread/gi;
/**
 * The engines as a whole: all, every, its or the engines ("all of the", "all of its", "all the",
 * a count in digits after the determiner, and "analytics" before the noun are allowed).
 */
const ENGINES_WHOLE =
  `\\b(?:(?:all\\s+(?:of\\s+)?)?(?:its|the)\\s+(?:${EM}\\d[\\d,]*${EM}\\s+)?(?:analytics\\s+)?engines` +
  `|all\\s+(?:${EM}\\d[\\d,]*${EM}\\s+)?(?:analytics\\s+)?engines|every\\s+(?:analytics\\s+)?engine)${EM}`;
/** …not after "of", "not" or "not all": "27 of the engines", "not all engines", "not every engine". */
const NOT_NARROWED = '(?<!\\b(?:of|not(?:\\s+all)?)\\s+)';
/** "worker" or "main thread", the first one within 60 characters, crossing neither "both" nor "either". */
const ONE_THREAD =
  '(?:(?!\\b(?:both|either|worker|main\\s+thread)\\b)(?:[^.;\\n]|\\n(?![ \\t]*\\n))){0,60}?(?:\\bworker\\b|\\bmain\\s+thread\\b)';
/** …unless "and" or "or" and a thread follow within 40 characters: a split is not one thread. */
const NOT_A_SPLIT =
  '(?!(?:[^.;\\n]|\\n(?![ \\t]*\\n)){0,40}?\\b(?:and|or)\\s+(?:(?:in|on)\\s+)?(?:the\\s+)?(?:analytics\\s+)?(?:worker|main\\s+thread)\\b)';
/**
 * The engines as a whole as the subject of a placement verb on one thread: NOT_NARROWED and
 * ENGINES_WHOLE, then (directly or after "all") run, live, sit, reside or execute, or is or are
 * (with an optional "all") followed by in, on, run, hosted, computed or executed; then ONE_THREAD
 * and NOT_A_SPLIT. The window stops at a period or a semicolon and crosses a wrapped line but not
 * a blank one. "All 62 engines run in the analytics worker" and "The engines all run in the
 * worker" match; "the engines on the main thread include …", "its engines split between the
 * worker and the main thread", "the engines run in the worker and on the main thread" and "the
 * engines run on both threads" do not.
 */
const ALL_ON_ONE_THREAD = new RegExp(
  NOT_NARROWED + ENGINES_WHOLE +
    '\\s+(?:all\\s+)?(?:runs?|lives?|sits?|resides?|executes?|(?:are|is)\\s+(?:all\\s+)?(?:in|on|run|hosted|computed|executed))\\b' +
    ONE_THREAD + NOT_A_SPLIT,
  'gi',
);
/**
 * The engines as a whole, or a count of them, as the object of run, host, execute, put, place or
 * keep (not after "not", "never" or "n't"), followed directly by in or on, "the", "a", "an" or
 * "one", an optional analytics, background, separate or single, and "worker" or "main thread",
 * then NOT_A_SPLIT: "It runs all engines in the analytics worker", "It runs **62 engines** on the
 * main thread". "It runs more than 40 engines in six groups" does not match.
 */
const OBJECT_ON_ONE_THREAD = new RegExp(
  `(?<!(?:\\bnot|\\bnever|n't)\\s+)\\b(?:runs?|hosts?|executes?|puts?|places?|keeps?)\\s+` +
    `(?:${ENGINES_WHOLE}|${EM}(?:more\\s+than\\s+)?${EM}\\d[\\d,]*${EM}\\s+${EM}(?:analytics\\s+)?engines${EM})` +
    '\\s+(?:all\\s+)?(?:in|on)\\s+(?:the|an?|one)\\s+(?:(?:analytics|background|separate|single)\\s+)?(?:worker|main\\s+thread)\\b' +
    NOT_A_SPLIT,
  'gi',
);

/**
 * Every engine count COUNT reads on the given surfaces must be written in digits, as the index
 * total or as a floor ("more than N") equal to the README's `floor` and below the strict reading;
 * never approximate, never in words. IN_A_WORKER, ALL_ON_ONE_THREAD and OBJECT_ON_ONE_THREAD must
 * not match.
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
      const isFloor = FLOOR_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index));
      if (!isFloor) {
        if (n !== summary.total) problems.push(`${at}: "${said}" is neither the index total (${summary.total}) nor a floor ("more than N engines")`);
        continue;
      }
      floors.push(n);
      if (n >= summary.strict) problems.push(`${at}: "more than ${n} engines" is not below the strict reading ${summary.strict}`);
      else if (floor != null && n !== floor) problems.push(`${at}: "more than ${n} engines" differs from the README's floor, more than ${floor}; every surface states the same floor`);
    }
    for (const re of [IN_A_WORKER, ALL_ON_ONE_THREAD, OBJECT_ON_ONE_THREAD]) {
      for (const m of text.matchAll(re)) {
        problems.push(`${path}:${lineOf(text, m.index)}: "${m[0]}" — the engines run on both threads; the index gives each one's thread`);
      }
    }
  }
  if (floor == null && floors.length) problems.push(`${floors.length} surface floor(s) cannot be compared: the README states no floor`);
  return { problems, counted: seen, floors: floors.length, surfaces: surfaces.length };
}
