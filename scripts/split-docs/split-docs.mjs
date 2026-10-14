#!/usr/bin/env node
/**
 * split-docs.mjs — v1.188.0: split the single-file manual into the engineering reference, the
 * frozen history and the option page, and prove that nothing was lost.
 *
 * WHY THIS EXISTS. Until v1.188.0 the whole manual was ecoflow_panel/DOCS.md: 1.17 MB that Home
 * Assistant rendered on every open of the Documentation tab and GitHub would not render at all.
 * The split moves it into docs/reference/ (one file per chapter or part, each small enough for
 * GitHub), docs/history/ (the per-release engineering log and the dated operations audits, frozen)
 * and docs/guide/options.md (the option table). A move by hand is how content goes missing, so the
 * split is a program and its declarations are data: split-map.tsv lists every run of the manual
 * and where it goes, and every edit, as an exact text that must match once. Every other byte moves
 * unchanged. The edits (E1–E6) are:
 *
 *   E1  chapter 10 section 2.6, the engineering release log → docs/history/engineering-release-log-1.md
 *       and -2.md (split at an entry boundary); the heading becomes "2.6 Engineering history (moved)"
 *       with a two-line pointer
 *   E2  the removed-HACS-cards note (chapter 11) and sections 12i–12o → docs/history/operations-audits.md,
 *       each replaced by a pointer section
 *   E3  the chapter 12 option table → docs/guide/options.md, replaced by a pointer
 *   E4  the preamble and table of contents → docs/reference/README.md; the table of contents is
 *       replaced by the index (how the reference is organised, the chapter manifest, the
 *       Moved-sections table, the history list)
 *   E5  the control bytes in the cleanText row (chapter 13) become the literal text \x00, \x1f, \x7f
 *   E6  raw placeholders (<age>, <level>, <time>, <reason>) that GitHub would swallow as HTML tags
 *       are put in code spans
 *
 * The history files, the option page and the index carry a framing prefix (the frozen-history
 * banner, the option page's title) declared in the map as well.
 *
 *   node scripts/split-docs/split-docs.mjs --write [--src <manual.md>] [--root <dir>]
 *       Split <manual.md> (default ecoflow_panel/DOCS.md) and write the destinations under <root>.
 *   node scripts/split-docs/split-docs.mjs --check [--src <manual.md>] [--root <dir>]
 *       Exit 0 only if the files under <root> are byte-identical to what --write would write.
 *   node scripts/split-docs/split-docs.mjs --verify <base.md> [--root <dir>]
 *       The proofs, from the files on disk and the map alone:
 *         V1  undo every edit and concatenate the destinations in source order: the result equals
 *             <base.md> in sha256 and byte count
 *         V2  scripts/check-docs.mjs --inventory: every section of <base.md> appears exactly once,
 *             byte-identical, except the sections an edit touches, whose unmatched blocks must each
 *             lie inside a declared edit's old text (or contain it)
 *         V3  release paragraphs (the D8 ratchet's count) in the history plus the rest equal the base
 *
 * The proofs hold for the split as committed: a later commit that edits a destination (the guide
 * commit completes docs/guide/options.md) makes --verify fail, as it should. Once the operator guide
 * replaces ecoflow_panel/DOCS.md, --write and --check need the pre-split manual through --src
 * (git show <base>:ecoflow_panel/DOCS.md > /tmp/manual.md).
 *
 * Re-running on a stale branch: run --write on that branch's manual, then --verify, then update
 * scripts/docs-baselines.json (history pins and ratchets) to the numbers check-docs prints.
 *
 * File access follows the repository's CodeQL rules: each file is read once, a missing file is a
 * caught ENOENT, and no path is probed before it is used. Committed with the split; removed in the
 * follow-up.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMarkdown } from '../lib/markdownScan.mjs';
import { inventory, ratchetCounts } from '../check-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MAP_FILE = join(HERE, 'split-map.tsv');
const SOURCE = 'ecoflow_panel/DOCS.md';
const INDEX = 'docs/reference/README.md';
const REFERENCE_PREFIX = 'docs/reference/';
/** A section's closing thematic break stays with the chapter when the section's text moves out. */
const SEPARATOR_TAIL = '\n---\n\n';
/** The `sub` new-text token for the generated index. */
const INDEX_TOKEN = '@index';
/** Keep a BOM if there is one; reject invalid UTF-8 (the round trip must be byte-exact). */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const sha256 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

class SplitError extends Error {}
const fail = (msg) => { throw new SplitError(msg); };

/** Read a UTF-8 text file once; null when it does not exist. */
function readText(path) {
  let buf;
  try { buf = readFileSync(path); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
  return UTF8.decode(buf);
}

/** Every index at which `needle` occurs in `hay` (overlaps included). */
function occurrences(hay, needle) {
  const out = [];
  if (needle === '') return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Replace the single occurrence of `old` in `text`; any other count is an error naming `what`. */
function replaceOnce(text, old, neu, what) {
  const at = occurrences(text, old);
  if (at.length !== 1) fail(`${what}: the old text occurs ${at.length} times (it must occur exactly once)`);
  return text.slice(0, at[0]) + neu + text.slice(at[0] + old.length);
}

/** Offsets of lines in `text` that start with `prefix`. */
function lineStartsWith(text, prefix) {
  return occurrences(text, prefix).filter((i) => i === 0 || text[i - 1] === '\n');
}

/* ─────────────────────────────── the map ─────────────────────────────── */

const COLUMNS = { seg: 4, move: 6, cut: 4, frame: 3, sub: 5, anchor: 4 };

/** Parse split-map.tsv. Text columns are JSON strings; `#` lines and blank lines are comments. */
export function parseMap(text) {
  const map = { segs: [], moves: [], cuts: [], frames: new Map(), subs: [], anchors: [] };
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const cols = line.split('\t');
    const kind = cols[0];
    const where = `split-map.tsv:${i + 1}`;
    if (!Object.hasOwn(COLUMNS, kind)) fail(`${where}: unknown row kind ${JSON.stringify(kind)}`);
    if (cols.length !== COLUMNS[kind]) fail(`${where}: a ${kind} row has ${COLUMNS[kind]} columns, not ${cols.length}`);
    const json = (c) => {
      let v;
      try { v = JSON.parse(c); } catch (e) { fail(`${where}: column is not a JSON string (${e.message})`); }
      if (typeof v !== 'string') fail(`${where}: column is not a JSON string`);
      return v;
    };
    if (kind === 'seg') map.segs.push({ dest: cols[1], first: json(cols[2]), label: json(cols[3]), where });
    else if (kind === 'move') map.moves.push({ id: cols[1], dest: cols[2], first: json(cols[3]), next: json(cols[4]), pointer: json(cols[5]), where });
    else if (kind === 'cut') map.cuts.push({ id: cols[1], dest: cols[2], prefix: json(cols[3]), where });
    else if (kind === 'frame') {
      if (map.frames.has(cols[1])) fail(`${where}: a second frame for ${cols[1]}`);
      map.frames.set(cols[1], json(cols[2]));
    } else if (kind === 'sub') map.subs.push({ id: cols[1], dest: cols[2], old: json(cols[3]), neu: json(cols[4]), where });
    else map.anchors.push({ old: cols[1], file: cols[2], slug: cols[3] === '-' ? '' : cols[3], where });
  });
  if (map.segs.length === 0 || map.segs[0].first !== '') fail('split-map.tsv: the first seg must start at the top of the manual ("")');
  for (const c of map.cuts) if (!map.moves.some((m) => m.id === c.id)) fail(`${c.where}: cut for unknown move ${c.id}`);
  return map;
}

export function loadMap() {
  const text = readText(MAP_FILE);
  if (text === null) fail(`${MAP_FILE} is missing`);
  return parseMap(text);
}

/** Destinations that hold moved text, each with its pieces in source (map) order. */
function movedDestinations(map) {
  const pieces = new Map();
  const add = (dest, piece) => { if (!pieces.has(dest)) pieces.set(dest, []); pieces.get(dest).push(piece); };
  for (const m of map.moves) {
    add(m.dest, { move: m.id, marker: m.first, part: 0 });
    map.cuts.filter((c) => c.id === m.id).forEach((c, k) => add(c.dest, { move: m.id, marker: c.prefix, part: k + 1 }));
  }
  return pieces;
}

/* ─────────────────────────────── the index ─────────────────────────────── */

/** The link text for a Moved-sections target (relative to docs/reference). */
const displayPath = (file) => (file.startsWith('../') ? file.slice(3) : file);

/** E4's new text: everything in the index after the moved preamble. */
export function indexTail(map) {
  const chapters = map.segs.filter((s) => s.dest.startsWith(REFERENCE_PREFIX) && s.dest !== INDEX)
    .map((s) => `- [${s.label}](${s.dest.slice(REFERENCE_PREFIX.length)})`);
  const rows = map.anchors.map((a) => {
    const target = a.file === 'README.md' ? `[Chapters](#${a.slug})` : `[${displayPath(a.file)}](${a.file}${a.slug ? `#${a.slug}` : ''})`;
    return `| \`#${a.old}\` | ${target} |`;
  });
  return [
    '## How this reference is organised',
    '',
    'This is the engineering reference for Power, the `ecoflow_panel` add-on: what each engine computes, from',
    'which inputs, with which guards, and where its output goes. Running the add-on day to day (setup, alarms,',
    'options, entities, troubleshooting) is covered by the operator guide,',
    '[`ecoflow_panel/DOCS.md`](../../ecoflow_panel/DOCS.md), which Home Assistant shows on the add-on\'s',
    'Documentation tab.',
    '',
    'These chapters were one file, `ecoflow_panel/DOCS.md`, until it outgrew what Home Assistant renders quickly',
    'and what GitHub renders at all. They were moved here byte for byte. The only edits are this index in place',
    'of the old table of contents, pointers where content moved out (the engineering release log and the',
    'operations audits to [`docs/history/`](../history/), the option table to',
    '[`docs/guide/options.md`](../guide/options.md)), three control bytes written out as text, and placeholders',
    'such as `<age>` put in code spans so that GitHub shows them. The chapters are as they stood in the',
    'single-file manual: the move did not re-check them against the code.',
    '',
    'Section numbers are chapter-local. A `§N` or `§N.M` inside a chapter means that chapter\'s own numbered',
    'heading unless it names another chapter (`§15.8b` is section 8b of chapter 15). Chapters 2, 8 and 15 are',
    'split into parts, and their section numbers run on across the parts.',
    '',
    '## Chapters',
    '',
    '<!-- chapters:start -->',
    ...chapters,
    '<!-- chapters:end -->',
    '',
    '## Moved sections',
    '',
    'A link into the old single-file manual (`ecoflow_panel/DOCS.md#…`) now opens the top of the operator guide.',
    'Every heading id that was linked (from this repository or from the old table of contents), and every section',
    'that moved out of the chapters, is listed here with the file it is in now. Headings moved unchanged, so the',
    'id is the same in its new file.',
    '',
    '| Old anchor | Now |',
    '|---|---|',
    ...rows,
    '',
    '## History',
    '',
    'Frozen, unedited and not part of the printable manual:',
    '',
    '- [engineering-release-log-1.md](../history/engineering-release-log-1.md) and',
    '  [engineering-release-log-2.md](../history/engineering-release-log-2.md): the per-release engineering notes',
    '  that were section 2.6 of chapter 10.',
    '- [operations-audits.md](../history/operations-audits.md): sections 12i–12o of chapter 12 and the note on the',
    '  removed HACS cards from chapter 11.',
    '',
    'What changed in each release is in the [CHANGELOG](../../ecoflow_panel/CHANGELOG.md) and on the',
    '[Releases](https://github.com/tesseractAZ/power/releases) page.',
    '',
  ].join('\n');
}

/* ─────────────────────────────── forward: split ─────────────────────────────── */

/** Split the manual. Returns a Map of destination path → text, in source order. */
export function split(src, map) {
  const scan = scanMarkdown(src);
  const { lines, lineStarts, lineKinds } = scan;
  const offsetOfLine = (n) => lineStarts[n - 1];
  const headingLine = (text, what) => {
    const hits = scan.headings.filter((h) => !h.setext && lines[h.line - 1] === text);
    if (hits.length !== 1) fail(`${what}: heading line ${JSON.stringify(text)} matches ${hits.length} headings (it must match one)`);
    return hits[0].line;
  };
  const anyLine = (text, what) => {
    const hits = [];
    lines.forEach((l, i) => { if (l === text && !lineKinds[i].startsWith('fence')) hits.push(i + 1); });
    if (hits.length !== 1) fail(`${what}: line ${JSON.stringify(text)} occurs ${hits.length} times outside code fences (it must occur once)`);
    return hits[0];
  };

  // segments
  const segs = map.segs.map((s, k) => ({ ...s, start: k === 0 ? 0 : offsetOfLine(headingLine(s.first, s.where)) }));
  segs.forEach((s, k) => { s.end = k + 1 < segs.length ? segs[k + 1].start : src.length; });
  for (let k = 1; k < segs.length; k++) if (segs[k].start <= segs[k - 1].start) fail(`${segs[k].where}: segments are out of source order`);
  const seenSeg = new Set();
  for (const s of segs) { if (seenSeg.has(s.dest)) fail(`${s.where}: ${s.dest} is a destination twice`); seenSeg.add(s.dest); }

  // moves (and their cuts)
  const moves = map.moves.map((m) => {
    const start = offsetOfLine(anyLine(m.first, m.where));
    let end = offsetOfLine(headingLine(m.next, m.where));
    if (end <= start) fail(`${m.where}: the next heading comes before the first line`);
    if (src.slice(start, end).endsWith(SEPARATOR_TAIL)) end -= SEPARATOR_TAIL.length;
    const seg = segs.find((s) => start >= s.start && end <= s.end);
    if (!seg) fail(`${m.where}: the moved text crosses a segment boundary`);
    if (start === seg.start) fail(`${m.where}: the moved text starts its segment (the chapter would open without its heading)`);
    const text = src.slice(start, end);
    const cuts = map.cuts.filter((x) => x.id === m.id);
    const bounds = [0];
    for (const c of cuts) {
      const at = lineStartsWith(text, c.prefix).filter((i) => i > bounds.at(-1));
      if (at.length !== 1) fail(`${c.where}: ${at.length} lines of ${m.id}'s moved text start with the cut prefix (it must be one)`);
      bounds.push(at[0]);
    }
    bounds.push(text.length);
    const parts = bounds.slice(0, -1).map((b, k) => ({ dest: k === 0 ? m.dest : cuts[k - 1].dest, text: text.slice(b, bounds[k + 1]) }));
    return { ...m, start, end, seg, parts };
  });
  for (let k = 1; k < moves.length; k++) if (moves[k].start < moves[k - 1].end) fail(`${moves[k].where}: moves overlap or are out of source order`);

  const out = new Map();
  for (const s of segs) {
    let text = '';
    let at = s.start;
    for (const m of moves.filter((x) => x.seg === s)) {
      text += src.slice(at, m.start) + m.pointer;
      at = m.end;
    }
    out.set(s.dest, text + src.slice(at, s.end));
  }
  for (const [dest, pieces] of movedDestinations(map)) {
    if (out.has(dest)) fail(`${dest} receives both a segment and moved text`);
    if (!map.frames.has(dest)) fail(`${dest} holds moved text but has no frame row`);
    let text = map.frames.get(dest);
    for (const p of pieces) text += moves.find((m) => m.id === p.move).parts[p.part].text;
    out.set(dest, text);
  }
  for (const dest of map.frames.keys()) if (!movedDestinations(map).has(dest)) fail(`frame for ${dest}, which holds no moved text`);

  for (const sub of map.subs) {
    if (!out.has(sub.dest)) fail(`${sub.where}: ${sub.dest} is not a destination`);
    const neu = sub.neu === INDEX_TOKEN ? indexTail(map) : sub.neu;
    out.set(sub.dest, replaceOnce(out.get(sub.dest), sub.old, neu, `${sub.where} (${sub.id})`));
  }

  checkAnchors(src, out, map);
  return out;
}

/** Each Moved-sections row: the old id was an unsuffixed heading id of the manual; the new one is unique where it points. */
function checkAnchors(src, out, map) {
  const old = scanMarkdown(src).headings;
  for (const a of map.anchors) {
    const hits = old.filter((h) => h.slug === a.old);
    if (hits.length !== 1 || hits[0].base !== a.old) fail(`${a.where}: #${a.old} is not one unsuffixed heading id of the manual`);
    const dest = a.file.startsWith('../') ? `docs/${a.file.slice(3)}` : `${REFERENCE_PREFIX}${a.file}`;
    if (!out.has(dest)) fail(`${a.where}: ${dest} is not a destination`);
    if (a.slug) {
      const hs = scanMarkdown(out.get(dest)).headings;
      const owners = hs.filter((h) => h.base === a.slug);
      if (owners.length !== 1 || owners[0].slug !== a.slug) fail(`${a.where}: #${a.slug} is not one unsuffixed heading id of ${dest}`);
    }
  }
}

/* ─────────────────────────────── reverse: V1 ─────────────────────────────── */

/**
 * Rebuild the manual from the destination files and the map alone: undo each `sub`, take the
 * frame off each moved-text destination and cut its body back into pieces, put each moved text
 * back in place of its pointer, and concatenate the segments in map order.
 */
export function reassemble(files, map) {
  const get = (dest) => {
    if (!files.has(dest)) fail(`V1: ${dest} is missing`);
    return files.get(dest);
  };
  const text = new Map();
  for (const s of map.segs) text.set(s.dest, get(s.dest));
  const moved = movedDestinations(map);
  for (const dest of moved.keys()) text.set(dest, get(dest));

  for (const sub of [...map.subs].reverse()) {
    const neu = sub.neu === INDEX_TOKEN ? indexTail(map) : sub.neu;
    text.set(sub.dest, replaceOnce(text.get(sub.dest), neu, sub.old, `V1 undo ${sub.id} in ${sub.dest}`));
  }

  const movedText = new Map(map.moves.map((m) => [m.id, []]));
  for (const [dest, pieces] of moved) {
    const frame = map.frames.get(dest) ?? fail(`V1: no frame for ${dest}`);
    const t = text.get(dest);
    if (!t.startsWith(frame)) fail(`V1: ${dest} does not open with its declared frame`);
    const body = t.slice(frame.length);
    const starts = [];
    let from = 0;
    pieces.forEach((p, k) => {
      const at = lineStartsWith(body, p.marker).filter((i) => i >= from);
      if (k === 0 ? at[0] !== 0 : at.length < 1) fail(`V1: piece ${k + 1} of ${dest} (${p.move}) is not where its marker is`);
      starts.push(at[0]);
      from = at[0] + 1;
    });
    pieces.forEach((p, k) => {
      movedText.get(p.move)[p.part] = body.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : body.length);
    });
  }

  for (const m of map.moves) {
    const parts = movedText.get(m.id);
    const whole = parts.join('');
    const holders = map.segs.filter((s) => occurrences(text.get(s.dest), m.pointer).length > 0);
    if (holders.length !== 1) fail(`V1: ${m.id}'s pointer is in ${holders.length} chapter files (it must be in one)`);
    text.set(holders[0].dest, replaceOnce(text.get(holders[0].dest), m.pointer, whole, `V1 undo ${m.id}`));
  }

  return map.segs.map((s) => text.get(s.dest)).join('');
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

const argValue = (argv, flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };

function readSource(path) {
  const t = readText(path);
  if (t === null) fail(`${path} is missing`);
  return t;
}

function destinations(map) {
  return [...map.segs.map((s) => s.dest), ...movedDestinations(map).keys()];
}

function readDestinations(root, map) {
  const files = new Map();
  for (const d of destinations(map)) {
    const t = readText(join(root, d));
    if (t !== null) files.set(d, t);
  }
  return files;
}

function verify(basePath, root, map) {
  const base = readSource(basePath);
  const files = readDestinations(root, map);
  let ok = true;

  // V1
  const rebuilt = reassemble(files, map);
  const v1 = sha256(rebuilt) === sha256(base) && bytes(rebuilt) === bytes(base);
  console.log(`V1 ${v1 ? 'PASS' : 'FAIL'}: rebuilt ${bytes(rebuilt)} B sha256 ${sha256(rebuilt)}; base ${bytes(base)} B sha256 ${sha256(base)}`);
  ok &&= v1;

  // V2
  const paths = destinations(map).map((d) => join(root, d));
  const rep = inventory(basePath, paths);
  // The inventory abbreviates an unmatched block's text; take the whole block from the base by
  // its first line and byte length.
  const baseBuf = Buffer.from(base, 'utf8');
  const lineByte = [0];
  for (let i = 0; i < baseBuf.length; i++) if (baseBuf[i] === 0x0a) lineByte.push(i + 1);
  const blockText = (b) => baseBuf.subarray(lineByte[b.line - 1], lineByte[b.line - 1] + b.bytes).toString('utf8');
  /** The declared edit an unmatched block belongs to: it lies inside the edit's old text, or holds it. */
  const editOf = (block) => map.subs.find((s) => s.old.includes(block) || block.includes(s.old))?.id ?? null;
  let uncovered = 0;
  for (const r of rep.rows.filter((x) => x.status === 'changed')) {
    const ids = r.missing.map((b) => editOf(blockText(b)));
    uncovered += ids.filter((id) => id === null).length;
    const blocks = r.missing.length ? r.missing.map((b, k) => `line ${b.line} ${b.bytes} B [${ids[k] ?? 'NOT A DECLARED EDIT'}]`).join(', ') : 'none';
    console.log(`V2   touched: ${r.path} (old line ${r.line}, ${r.bytes} B): ${r.accounted} B found block by block; unmatched blocks: ${blocks}`);
  }
  for (const r of rep.rows.filter((x) => x.status === 'duplicated')) console.log(`V2   duplicated: ${r.path} (old line ${r.line}) at ${r.at.map((a) => `${a.file}:${a.line}`).join(', ')}`);
  const t = rep.totals;
  const v2 = t.duplicated === 0 && uncovered === 0;
  console.log(`V2 ${v2 ? 'PASS' : 'FAIL'}: ${t.sections} old sections — ${t.same} byte-identical and found once (${t.sameBytes} B), ${t.changed} touched by a declared edit, ${t.duplicated} duplicated; ${uncovered} unmatched block(s) outside the declared edits; ${t.addedSections} new section(s), ${t.addedBytes} B`);
  ok &&= v2;

  // V3 — the D8 counts, by where they went. The index's own note on section numbers (E4's new
  // text) is not from the manual, so it is counted apart and taken off.
  const baseCount = ratchetCounts(base);
  const groups = {
    history: [...files].filter(([d]) => d.startsWith('docs/history/')),
    reference: [...files].filter(([d]) => d.startsWith(REFERENCE_PREFIX) && d !== INDEX),
    guide: [...files].filter(([d]) => d.startsWith('docs/guide/')),
    index: [...files].filter(([d]) => d === INDEX),
  };
  const tail = ratchetCounts(indexTail(map));
  const sum = (xs, k) => xs.reduce((a, [, txt]) => a + ratchetCounts(txt)[k], 0);
  for (const k of ['releaseParagraphs', 'fileLineCitations', 'sectionSigns']) {
    const by = Object.fromEntries(Object.entries(groups).map(([g, xs]) => [g, sum(xs, k)]));
    const total = by.history + by.reference + by.guide + by.index - tail[k];
    const pass = total === baseCount[k];
    ok &&= pass;
    console.log(`V3 ${pass ? 'PASS' : 'FAIL'} ${k}: history ${by.history} + reference ${by.reference} + guide ${by.guide} + index ${by.index} (less ${tail[k]} in E4's new text) = ${total}; base ${baseCount[k]}`);
  }
  return ok;
}

function main(argv) {
  const root = resolve(argValue(argv, '--root', REPO));
  const map = loadMap();
  if (argv.includes('--verify')) {
    const base = argValue(argv, '--verify');
    if (!base) fail('usage: --verify <base.md> [--root <dir>]');
    process.exit(verify(resolve(base), root, map) ? 0 : 1);
  }
  const srcPath = resolve(argValue(argv, '--src', join(root, SOURCE)));
  const out = split(readSource(srcPath), map);
  if (argv.includes('--write')) {
    for (const [dest, text] of out) {
      mkdirSync(dirname(join(root, dest)), { recursive: true });
      writeFileSync(join(root, dest), text);
      console.log(`${String(bytes(text)).padStart(7)} B  ${dest}`);
    }
    return;
  }
  if (argv.includes('--check')) {
    let bad = 0;
    for (const [dest, text] of out) {
      const disk = readText(join(root, dest));
      if (disk !== text) { bad++; console.error(`${dest}: ${disk === null ? 'missing' : 'differs from the split'}`); }
    }
    console.log(bad ? `split-docs: ${bad} of ${out.size} destination(s) differ` : `split-docs: all ${out.size} destinations match the split of ${srcPath}`);
    process.exit(bad ? 1 : 0);
  }
  console.error('usage: split-docs.mjs --write|--check [--src <manual.md>] [--root <dir>] | --verify <base.md> [--root <dir>]');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) {
    if (e instanceof SplitError) { console.error(`split-docs: ${e.message}`); process.exit(1); }
    throw e;
  }
}
