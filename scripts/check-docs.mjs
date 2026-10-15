#!/usr/bin/env node
/**
 * v1.188.0 — hold the documentation to its size and structure.
 *
 * WHY THIS EXISTS. Home Assistant's Documentation tab fetches and renders the whole of
 * `ecoflow_panel/DOCS.md` on every open, with no cache and no size cap. The file grew to
 * 1.14 MB (about 24 KB a day, most of it a per-release log already in the CHANGELOG), took
 * 100–220 ms of DOM work on a desktop to render, and GitHub refused to render it at all, so
 * every inbound `DOCS.md#…` link landed on raw text. Every heading anchor inside it was dead in
 * Home Assistant, which gives headings no ids. v1.188.0 splits it: an operator guide of 32 KiB
 * or less in DOCS.md, an Info-tab card, the option and entity tables in `docs/guide/`, the
 * engineering reference in `docs/reference/` (one file per chapter or part, each small enough
 * for GitHub to render) and the frozen release log and audits in `docs/history/`. None of that
 * holds unless something fails when it stops holding: CHANGELOG.md was trimmed once before
 * with only a sentence to keep it small and grew back to 330 KB. This script is the mechanism.
 *
 *   node scripts/check-docs.mjs --check [--root <dir>] [--only D1,D5]
 *       Rules D1–D11 below; exit 1 on any violation. server/test/docsLayout.test.ts runs it in
 *       the required Server tests job, on the tree and on fixtures.
 *   node scripts/check-docs.mjs --inventory <old.md> -- <new.md…> [--json]
 *       Section-by-section byte accounting for a move: every section of <old> (keyed by heading
 *       path, hashed with sha256) is looked up in the new files. Exit 0 only when each one
 *       appears exactly once, byte-identical. Unmatched sections are broken into blocks so the
 *       bytes a declared edit changed can be told apart from bytes that were lost.
 *   node scripts/check-docs.mjs --slugs <file.md>
 *       Print each heading with the id GitHub gives it.
 *
 * Rules (each violation names its rule):
 *   D1  sizes in UTF-8 bytes (the guide's pair comes from roll-changelog.mjs), required files
 *   D2  no control bytes (0x00–08, 0x0B–1F including CR, 0x7F); valid UTF-8
 *   D3  Home Assistant surfaces (the guide and the add-on README): one h1; links absolute and,
 *       for this repository, only `blob|tree/main/<path>`, /releases, /issues, /security; no
 *       images, no `<a>`, no raw HTML but comments, details, summary and br; no add-on version,
 *       ISO date or section sign. The version and date bans also cover docs/guide.
 *   D4  names in the guide and docs/guide: a backticked UPPER_SNAKE token is an option key, a
 *       `PREFIX_*` matching one, or an allowlisted name; a backticked `ecoflow_…` id is a
 *       unique_id in entities.md
 *   D5  every relative or blob/main link target exists; every fragment is the unsuffixed slug
 *       of exactly one heading in its target; no `#L<n>` line anchors
 *   D6  the reference manifest lists every reference file once, in order; chapter files open
 *       with their `## N.` / `## Appendix X` heading, later parts with `###`; fences balance
 *   D7  options.md has one row per option key, its default and schema equal config.yaml's
 *   D8  ratchets on the reference (release-note paragraphs, `file:line` citations, section
 *       signs) equal their baselines; no release-log or changelog heading outside CHANGELOG*
 *   D9  docs/history holds exactly the pinned files, byte-identical, each with its banner
 *   D10 no pointer into the old monolith by section sign or quoted heading anywhere in code,
 *       config, .github or the checked Markdown; every docs/…/*.md mention exists
 *   D11 the guide's write table has a row for every writer phrase in WRITERS: the phrase, in
 *       bold, in the first cell of a row of a table inside the write section (a sentence that
 *       mentions a writer in passing does not stand in for its row)
 *
 * File access follows the CodeQL rules for this repository: each file is read once and its
 * size taken from the buffer; a missing file is a caught ENOENT, never a stat or an existence
 * probe first; directories are walked with readdirSync({ withFileTypes }) from explicit roots
 * (harness workers have no .git), skipping symlinks, node_modules and dist. Patterns that name
 * the banned forms are built by concatenation so this file and its tests cannot match them.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLL_TARGET_BYTES, LIVE_LIMIT_BYTES } from './roll-changelog.mjs';
import { scanMarkdown, readTables, splitSections } from './lib/markdownScan.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────────────────────────── layout ─────────────────────────────── */

export const GUIDE = 'ecoflow_panel/DOCS.md';
export const ADDON_README = 'ecoflow_panel/README.md';
export const HA_SURFACES = [GUIDE, ADDON_README];
export const GUIDE_DIR = 'docs/guide';
export const OPTIONS_PAGE = `${GUIDE_DIR}/options.md`;
export const ENTITIES_PAGE = `${GUIDE_DIR}/entities.md`;
export const REFERENCE_DIR = 'docs/reference';
export const REFERENCE_INDEX = `${REFERENCE_DIR}/README.md`;
export const HISTORY_DIR = 'docs/history';
export const CONFIG_YAML = 'ecoflow_panel/config.yaml';
export const BASELINES = 'scripts/docs-baselines.json';
export const REQUIRED = [GUIDE, ADDON_README, OPTIONS_PAGE, ENTITIES_PAGE, REFERENCE_INDEX];

/** The guide renders in the HA tab on every open: the same budget as the HA Changelog dialog. */
export const GUIDE_TARGET_BYTES = ROLL_TARGET_BYTES;
export const GUIDE_LIMIT_BYTES = LIVE_LIMIT_BYTES;
/** A guide this small has lost its content, not been tidied. */
export const GUIDE_FLOOR_BYTES = 8 * 1024;
export const ADDON_README_LIMIT_BYTES = 4 * 1024;
export const GUIDE_PAGE_LIMIT_BYTES = 64 * 1024;
export const REFERENCE_INDEX_LIMIT_BYTES = 16 * 1024;
/** GitHub's render cutoff starts around 250 KB and is not monotonic: files start at ≤ 96 KiB. */
export const REFERENCE_TARGET_BYTES = 96 * 1024;
export const REFERENCE_LIMIT_BYTES = 128 * 1024;
export const HISTORY_LIMIT_BYTES = 128 * 1024;
export const OTHER_DOC_LIMIT_BYTES = 128 * 1024;

/**
 * D11 — every `export async function` in server/src/ecoflow/commands.ts (each one writes to the
 * panel) and the row label(s) the guide's write table must carry for it, one per family of call
 * sites: each phrase must appear exactly as written, in bold, in the first cell of a row.
 * docsLayout.test.ts fails when the keys and the exports differ. `ch{n}ForceCharge` is the
 * switch on each of the panel's three AC slots (one Core each), not on a load circuit.
 */
export const WRITERS = {
  setBackupReserveSoc: ['Backup-reserve setpoint', 'Reserve floor'],
  setChannelForceCharge: ['Force charge ON/OFF per Core slot', 'Force charge OFF'],
  setForceChargeCeiling: ['force-charge ceiling'],
  refreshShp2CloudPresence: ['Cloud-presence refresh'],
  debugSendCommand: ['Raw command'],
};
export const WRITE_SECTION = 'What Power changes on your system';

/** D4 — the `<p>` placeholder in an entity unique_id (docsLayout pins it to ALARM_PRIORITY_ORDER). */
export const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/* Banned forms, built so that no line of this file is itself an instance. */
const SECTION_SIGN = String.fromCharCode(0xa7);
const LEFT_QUOTE = String.fromCharCode(0x201c);
const MONOLITH = 'DO' + 'CS';
/**
 * The old monolith's name, optionally with `.md`, then a section sign or a curly open quote, or a
 * space and a straight double quote: a pointer by section number or by quoted heading, which goes
 * stale the moment the heading moves file. The straight quote needs the space so a string literal
 * naming the file (its closing quote) is not a pointer.
 */
const MONOLITH_POINTER = new RegExp(MONOLITH + '(?:\\.md)?(?:[ \\t]*[' + SECTION_SIGN + LEFT_QUOTE + ']|[ \\t]+")', 'g');
/**
 * An add-on version (1.188.0, v1.187.22) that is not part of a longer dotted number. After it, a
 * word character or a dot and a digit (1.2.3.4) disqualify it; a sentence's full stop does not.
 */
const VERSION = /(?<![\w.])v?1\.\d{1,3}\.\d+(?!\w|\.\d)/g;
/** An ISO calendar date. */
const ISO_DATE = /(?<![\w-])(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\w])/g;
/** A heading that would hold release narrative. */
const RELEASE_HEADING = /release (?:log|notes)|changelog/i;
/** A `file.ext:NNN` citation: the extension and line, after an identifier character. */
const FILE_LINE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|py|ya?ml|sh|json|txt|md|toml):\d/g;
const ALLOWED_HTML = new Set(['!--', 'details', 'summary', 'br']);
const REPO_OWNER = 'tesseractaz';
const REPO_NAME = 'power';
const REPO_SECTIONS = new Set(['releases', 'issues', 'security']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '.yaml', '.yml',
  '.py', '.sh', '.bash', '.txt', '.md', '.toml', '.html', '.css', '.conf', '.cfg', '.ini', '.service', '.plist', '.xml', '']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SKIP_FILES = new Set(['package-lock.json']);

/* ─────────────────────────────── tree access ─────────────────────────────── */

const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const extOf = (rel) => { const b = baseOf(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
const isChangelog = (rel) => baseOf(rel).startsWith('CHANGELOG');
export const isHistory = (rel) => dirOf(rel) === HISTORY_DIR;
export const isReference = (rel) => dirOf(rel) === REFERENCE_DIR && rel !== REFERENCE_INDEX;
export const isGuidePage = (rel) => dirOf(rel) === GUIDE_DIR;

/** Every file and directory under root, posix-relative, skipping symlinks, node_modules, dist and .git. */
export function walkTree(root) {
  const files = [];
  const dirs = new Set(['']);
  const visit = (rel) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || child === 'web/dist') continue;
        dirs.add(child);
        visit(child);
      } else if (ent.isFile()) {
        files.push(child);
      }
    }
  };
  visit('');
  files.sort();
  return { files, fileSet: new Set(files), dirs };
}

/** Read a file once: `{ buf, size }`, or null when it does not exist. */
function readOnce(root, rel) {
  try {
    const buf = readFileSync(join(root, rel));
    return { buf, size: buf.length };
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The Markdown files the rules cover: root *.md, and *.md under .github, docs and ecoflow_panel. */
export function checkedMarkdown(tree) {
  return tree.files.filter((rel) => extOf(rel) === '.md' && !isChangelog(rel)
    && (!rel.includes('/') || rel.startsWith('.github/') || rel.startsWith('docs/') || rel.startsWith('ecoflow_panel/')));
}

/* ─────────────────────────────── config.yaml ─────────────────────────────── */

/** A YAML plain or quoted scalar, as the Supervisor reads these flat option values. */
export function yamlScalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\' && i + 1 < v.length) { out += v[i + 1]; i++; continue; }
      if (v[i] === '"') return out;
      out += v[i];
    }
    return out;
  }
  if (v.startsWith("'")) {
    const end = v.lastIndexOf("'");
    return v.slice(1, end > 0 ? end : v.length).replaceAll("''", "'");
  }
  const hash = v.indexOf(' #');
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** The flat `options:` and `schema:` maps and the version from the add-on config.yaml. */
export function parseAddonConfig(text) {
  const out = { options: new Map(), schema: new Map(), version: null };
  let block = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line[0] !== ' ') {
      const colon = line.indexOf(':');
      const key = colon > 0 ? line.slice(0, colon) : line;
      block = key === 'options' || key === 'schema' ? key : null;
      if (key === 'version') out.version = yamlScalar(line.slice(colon + 1));
      continue;
    }
    if (!block || !line.startsWith('  ') || line[2] === ' ') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    out[block].set(line.slice(2, colon).trim(), yamlScalar(line.slice(colon + 1)));
  }
  return out;
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

const isUpperToken = (s) => /^[A-Z][A-Z0-9_*]+$/.test(s);

/** Does a `PREFIX_*`-style glob match a key? Literal pieces in order, `*` spans anything. */
export function globMatches(glob, key) {
  const parts = glob.split('*');
  if (!key.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === parts.length - 1) return key.length - p.length >= at && key.endsWith(p);
    const found = key.indexOf(p, at);
    if (found < 0) return false;
    at = found + p.length;
  }
  return at === key.length;
}

/** Does a unique_id (concrete or patterned) match an entities.md pattern with `<ch>` / `<p>`? */
export function idMatches(id, pattern) {
  if (id === pattern) return true;
  const parts = pattern.split(/(<ch>|<p>)/);
  const rec = (pi, si) => {
    if (pi === parts.length) return si === id.length;
    const part = parts[pi];
    if (part === '<ch>') {
      let k = si;
      while (k < id.length && id[k] >= '0' && id[k] <= '9') { k++; if (rec(pi + 1, k)) return true; }
      return false;
    }
    if (part === '<p>') return PRIORITIES.some((p) => id.startsWith(p, si) && rec(pi + 1, si + p.length));
    return id.startsWith(part, si) && rec(pi + 1, si + part.length);
  };
  return rec(0, 0);
}

/** First code span of a table cell, or the cell's text with `\|` unescaped. */
const cellCode = (cell) => {
  const t = cell.trim();
  if (t.startsWith('`')) {
    const end = t.indexOf('`', 1);
    if (end > 0) return t.slice(1, end).replaceAll('\\|', '|').trim();
  }
  return t.replaceAll('\\|', '|');
};
const isSingleCode = (cell) => { const t = cell.trim(); return t.length > 2 && t.startsWith('`') && t.endsWith('`') && t.indexOf('`', 1) === t.length - 1; };

/** Normalise an options.md Default cell to the scalar config.yaml holds. */
export function normalizeDefault(cell) {
  let t = cell.trim();
  if (isSingleCode(t)) t = t.slice(1, -1);
  if (t === 'empty' || t === '""' || t === "''") return '';
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

/** Normalise an options.md Schema cell (first code span, `\|` unescaped, quotes dropped). */
export function normalizeSchema(cell) {
  let t = cellCode(cell);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

const sameScalar = (a, b) => a === b
  || (a.trim() !== '' && b.trim() !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b));

/** The unique_id column of entities.md: every code span in a column headed `unique_id`. */
export function entityIds(scan) {
  const ids = [];
  for (const t of readTables(scan)) {
    const col = t.header.findIndex((h) => h.replaceAll('`', '').trim().toLowerCase() === 'unique_id');
    if (col < 0) continue;
    for (const r of t.rows) {
      const cell = r.cells[col] ?? '';
      for (let i = cell.indexOf('`'); i >= 0;) {
        const end = cell.indexOf('`', i + 1);
        if (end < 0) break;
        ids.push({ id: cell.slice(i + 1, end).trim(), line: r.line });
        i = cell.indexOf('`', end + 1);
      }
    }
  }
  return ids;
}

/** Reference file name → `{ chapter, part, appendix }`, or null when it is not a reference name. */
export function referenceName(base) {
  const m = /^(\d\d)-(?:(\d)-)?[a-z][a-z0-9-]*\.md$/.exec(base);
  if (m) return { chapter: Number(m[1]), part: m[2] ? Number(m[2]) : 0, appendix: null };
  const a = /^([A-Z])-[a-z][a-z0-9-]*\.md$/.exec(base);
  if (a) return { chapter: null, part: 0, appendix: a[1] };
  return null;
}

/** D8 counts over one reference file's text. */
export function ratchetCounts(text, scan = scanMarkdown(text)) {
  let releaseParagraphs = 0;
  for (const p of scan.paragraphs) {
    if (p.text.startsWith('**v') && p.text[3] >= '0' && p.text[3] <= '9') releaseParagraphs++;
  }
  let fileLineCitations = 0;
  for (const m of text.matchAll(FILE_LINE)) {
    const prev = text[m.index - 1];
    if (prev !== undefined && /^[A-Za-z0-9_-]$/.test(prev)) fileLineCitations++;
  }
  let sectionSigns = 0;
  for (const ch of text) if (ch === SECTION_SIGN) sectionSigns++;
  return { releaseParagraphs, fileLineCitations, sectionSigns };
}
export const RATCHETS = ['releaseParagraphs', 'fileLineCitations', 'sectionSigns'];

const lineOfIndex = (text, idx) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < idx; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ─────────────────────────────── the check ─────────────────────────────── */

/**
 * Run the rules over the tree at `root`. Returns `{ violations, notes, checked }`; a violation is
 * `{ rule, file, line, message }`. `only` restricts the rules (e.g. ['D1', 'D5']).
 */
export function runChecks(root = REPO, { only = null } = {}) {
  const violations = [];
  const notes = [];
  const fail = (rule, file, line, message) => violations.push({ rule, file, line, message });
  const want = (rule) => !only || only.includes(rule);

  const tree = walkTree(root);
  const docs = new Map(); // rel → { buf, size, text, utf8, scan } | null
  const loadDoc = (rel) => {
    if (docs.has(rel)) return docs.get(rel);
    const r = readOnce(root, rel);
    let doc = null;
    if (r) {
      let text;
      let utf8 = true;
      try { text = UTF8.decode(r.buf); } catch { text = r.buf.toString('utf8'); utf8 = false; }
      let scan = null;
      doc = { ...r, text, utf8, get scan() { scan ??= scanMarkdown(text); return scan; } };
    }
    docs.set(rel, doc);
    return doc;
  };
  const mdFiles = checkedMarkdown(tree).filter((rel) => loadDoc(rel) !== null);

  let baselines = null;
  {
    const r = readOnce(root, BASELINES);
    if (r) {
      try { baselines = JSON.parse(r.buf.toString('utf8')); } catch (e) { fail('D8', BASELINES, 1, `not valid JSON: ${e.message}`); }
    }
  }
  let config = null;
  {
    const r = readOnce(root, CONFIG_YAML);
    if (r) config = parseAddonConfig(r.buf.toString('utf8'));
  }

  /* D1 — sizes and required files */
  if (want('D1')) {
    for (const rel of REQUIRED) {
      if (!loadDoc(rel)) fail('D1', rel, 0, 'required file is missing');
    }
    const budget = (rel) => {
      if (rel === GUIDE) return { limit: GUIDE_LIMIT_BYTES, target: GUIDE_TARGET_BYTES, floor: GUIDE_FLOOR_BYTES };
      if (rel === ADDON_README) return { limit: ADDON_README_LIMIT_BYTES };
      if (isGuidePage(rel)) return { limit: GUIDE_PAGE_LIMIT_BYTES };
      if (rel === REFERENCE_INDEX) return { limit: REFERENCE_INDEX_LIMIT_BYTES };
      if (isReference(rel)) return { limit: REFERENCE_LIMIT_BYTES, target: REFERENCE_TARGET_BYTES };
      if (isHistory(rel)) return { limit: HISTORY_LIMIT_BYTES };
      return { limit: OTHER_DOC_LIMIT_BYTES };
    };
    for (const rel of mdFiles) {
      const d = loadDoc(rel);
      const b = budget(rel);
      const size = d.size;
      if (size > b.limit) {
        fail('D1', rel, 0, `${size} bytes, over the ${b.limit}-byte limit${rel === GUIDE ? ' — Home Assistant renders all of it on every open of the Documentation tab' : ''}`
          + (isReference(rel) ? '; split it at a ### heading into the next -k part and prove the move with --inventory' : ''));
      } else if (b.target !== undefined && size > b.target) {
        notes.push(`D1 ${rel}: ${size} bytes, over the ${b.target}-byte target (limit ${b.limit})`);
      }
      if (b.floor !== undefined && size < b.floor) {
        fail('D1', rel, 0, `${size} bytes, under the ${b.floor}-byte floor — the operator guide has lost its content`);
      }
    }
  }

  /* D2 — control bytes, UTF-8 */
  if (want('D2')) {
    for (const rel of mdFiles) {
      const d = loadDoc(rel);
      if (!d.utf8) fail('D2', rel, 0, 'not valid UTF-8');
      let line = 1;
      for (let i = 0; i < d.buf.length; i++) {
        const b = d.buf[i];
        if (b === 0x0a) { line++; continue; }
        if (b === 0x09) continue;
        if (b <= 0x1f || b === 0x7f) {
          fail('D2', rel, line, `control byte 0x${b.toString(16).padStart(2, '0')}${b === 0x0d ? ' (CR: use LF line endings)' : ''}`);
        }
      }
    }
  }

  const repoUrl = (dest) => {
    let u;
    try { u = new URL(dest); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com' && host !== 'raw.githubusercontent.com') return null;
    const segs = u.pathname.split('/').slice(1);
    if ((segs[0] ?? '').toLowerCase() !== REPO_OWNER || (segs[1] ?? '').toLowerCase() !== REPO_NAME) return null;
    return { url: u, host, segs: segs.slice(2) };
  };

  /* D3 — Home Assistant surfaces */
  if (want('D3')) {
    for (const rel of HA_SURFACES) {
      const d = loadDoc(rel);
      if (!d) continue;
      const { scan } = d;
      const h1 = scan.headings.filter((h) => h.level === 1);
      if (h1.length !== 1) fail('D3', rel, h1[1]?.line ?? 1, `${h1.length} level-1 headings; a Home Assistant surface has exactly one`);
      for (const l of scan.links) {
        if (l.image) { fail('D3', rel, l.line, `image ${JSON.stringify(l.dest)} — Home Assistant surfaces carry no images`); continue; }
        if (l.dest.startsWith('#')) { fail('D3', rel, l.line, `in-page link ${JSON.stringify(l.dest)} — headings have no ids in Home Assistant`); continue; }
        let u = null;
        try { u = new URL(l.dest); } catch { /* relative */ }
        if (!u) { fail('D3', rel, l.line, `relative link ${JSON.stringify(l.dest)} — Home Assistant cannot follow it; use https://github.com/tesseractAZ/power/blob/main/<path>`); continue; }
        if (u.protocol !== 'https:' && u.protocol !== 'mailto:') { fail('D3', rel, l.line, `${u.protocol} link ${JSON.stringify(l.dest)} — use https, or put a LAN address in a code span`); continue; }
        const r = repoUrl(l.dest);
        if (!r) continue;
        const kind = r.segs[0];
        const okTree = r.host !== 'raw.githubusercontent.com' && (kind === 'blob' || kind === 'tree') && r.segs[1] === 'main' && r.segs.length > 2 && r.segs[2] !== '';
        const okSection = r.host !== 'raw.githubusercontent.com' && REPO_SECTIONS.has(kind);
        if (!(okTree || okSection) || r.url.search !== '') {
          fail('D3', rel, l.line, `repository link ${JSON.stringify(l.dest)} — only blob/main or tree/main paths, /releases, /issues and /security (the Supervisor serves main's copy to every installed version)`);
        }
      }
      for (const t of scan.html) {
        if (t.tag === 'a') fail('D3', rel, t.line, `${t.raw} — no <a> shims or anchors: Home Assistant drops ids`);
        else if (!ALLOWED_HTML.has(t.tag)) fail('D3', rel, t.line, `raw HTML ${t.raw} — only comments, details, summary and br; wrap a placeholder like <age> in backticks`);
      }
      for (const m of d.text.matchAll(new RegExp(SECTION_SIGN, 'g'))) fail('D3', rel, lineOfIndex(d.text, m.index), 'section sign — section numbers are reference-internal');
    }
    for (const rel of [...HA_SURFACES, ...mdFiles.filter(isGuidePage)]) {
      const d = loadDoc(rel);
      if (!d) continue;
      for (const m of d.text.matchAll(VERSION)) fail('D3', rel, lineOfIndex(d.text, m.index), `version ${m[0]} — what changed belongs in CHANGELOG.md; describe the present`);
      for (const m of d.text.matchAll(ISO_DATE)) fail('D3', rel, lineOfIndex(d.text, m.index), `date ${m[0]} — no dates on operator pages`);
    }
  }

  /* D4 — names */
  if (want('D4')) {
    const ent = loadDoc(ENTITIES_PAGE);
    if (!ent) fail('D4', ENTITIES_PAGE, 0, 'missing — every backticked ecoflow_… id is checked against its unique_id column');
    const patterns = ent ? entityIds(ent.scan) : [];
    const seen = new Map();
    for (const p of patterns) {
      if (!p.id.startsWith('ecoflow_')) fail('D4', ENTITIES_PAGE, p.line, `unique_id ${JSON.stringify(p.id)} does not start with ecoflow_`);
      if (seen.has(p.id)) fail('D4', ENTITIES_PAGE, p.line, `unique_id ${p.id} has two rows (first at line ${seen.get(p.id)})`);
      else seen.set(p.id, p.line);
    }
    if (ent && patterns.length === 0) fail('D4', ENTITIES_PAGE, 0, 'no table with a unique_id column');
    const keys = config ? [...config.options.keys()] : [];
    if (!config) fail('D4', CONFIG_YAML, 0, 'missing — option names cannot be checked');
    const allow = new Set(Array.isArray(baselines?.nameAllowlist) ? baselines.nameAllowlist : []);
    for (const rel of [...HA_SURFACES, ...mdFiles.filter(isGuidePage)]) {
      const d = loadDoc(rel);
      if (!d) continue;
      for (const c of d.scan.codeSpans) {
        const t = c.content.trim();
        if (isUpperToken(t)) {
          const known = t.includes('*') ? keys.some((k) => globMatches(t, k)) : keys.includes(t);
          if (!known && !allow.has(t)) fail('D4', rel, c.line, `\`${t}\` is not an option key${t.includes('*') ? ' pattern matching any key' : ''} or an allowlisted name (${BASELINES} nameAllowlist)`);
        } else if (t.startsWith('ecoflow_') && !t.includes('/')) {
          // the id is the identifier-shaped head of the span (`ecoflow_x_watts > 0` names ecoflow_x_watts)
          const id = /^ecoflow_[A-Za-z0-9_<>]*/.exec(t)[0];
          if (id !== 'ecoflow_panel' && !patterns.some((p) => idMatches(id, p.id))) fail('D4', rel, c.line, `\`${id}\` is not a unique_id in ${ENTITIES_PAGE}`);
        }
      }
    }
  }

  /* D5 — link targets and fragments */
  if (want('D5')) {
    /**
     * A fragment is good when exactly one heading has it as its base slug AND GitHub gives that
     * heading exactly this id (two "Foo" headings make "Foo 1" foo-1-1, and foo-1 is the second
     * Foo), and no other heading carries it.
     */
    const checkFragment = (rel, line, target, frag, dest) => {
      if (/^L\d/.test(frag)) { fail('D5', rel, line, `${JSON.stringify(dest)} — line anchors (#L<n>) go stale on the next edit; link the heading`); return; }
      if (extOf(target) !== '.md' || !tree.fileSet.has(target)) { fail('D5', rel, line, `${JSON.stringify(dest)} — a fragment needs a Markdown file target`); return; }
      const headings = loadDoc(target).scan.headings;
      const owners = headings.filter((h) => h.base === frag);
      const carriers = headings.filter((h) => h.slug === frag);
      if (owners.length !== 1 || carriers.length !== 1 || carriers[0] !== owners[0]) {
        const why = owners.length > 1 ? 'is shared by several headings (link a unique one)'
          : carriers.length > 0 ? 'is a -N duplicate suffix, which moves when a heading is added'
            : 'matches no heading';
        fail('D5', rel, line, `${JSON.stringify(dest)} — #${frag} ${why} in ${target}`);
      }
    };
    for (const rel of mdFiles) {
      if (isHistory(rel)) continue;
      const d = loadDoc(rel);
      for (const l of d.scan.links) {
        if (l.kind === 'reference') continue; // its definition is checked
        const dest = l.dest;
        let u = null;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest)) {
          try { u = new URL(dest); } catch { fail('D5', rel, l.line, `unparseable URL ${JSON.stringify(dest)}`); continue; }
          const r = repoUrl(dest);
          if (!r || r.host === 'raw.githubusercontent.com') continue;
          if (!((r.segs[0] === 'blob' || r.segs[0] === 'tree') && r.segs[1] === 'main')) continue;
          let path;
          try { path = r.segs.slice(2).map(decodeURIComponent).join('/'); } catch { fail('D5', rel, l.line, `bad escape in ${JSON.stringify(dest)}`); continue; }
          path = path.replace(/\/$/, '');
          const exists = r.segs[0] === 'blob' ? tree.fileSet.has(path) : (tree.dirs.has(path) || tree.fileSet.has(path));
          if (!exists) { fail('D5', rel, l.line, `${JSON.stringify(dest)} — ${path} does not exist on this tree`); continue; }
          if (u.hash.length > 1) {
            let f;
            try { f = decodeURIComponent(u.hash.slice(1)); } catch { fail('D5', rel, l.line, `bad escape in ${JSON.stringify(dest)}`); continue; }
            checkFragment(rel, l.line, path, f, dest);
          }
          continue;
        }
        // relative (or fragment-only) link
        const hashAt = dest.indexOf('#');
        let pathPart = hashAt >= 0 ? dest.slice(0, hashAt) : dest;
        const frag = hashAt >= 0 ? dest.slice(hashAt + 1) : '';
        const q = pathPart.indexOf('?');
        if (q >= 0) pathPart = pathPart.slice(0, q);
        let decoded;
        try { decoded = decodeURIComponent(pathPart); } catch { fail('D5', rel, l.line, `bad escape in ${JSON.stringify(dest)}`); continue; }
        let target = rel;
        if (decoded !== '') {
          const joined = decoded.startsWith('/') ? decoded.slice(1) : (dirOf(rel) ? `${dirOf(rel)}/${decoded}` : decoded);
          const parts = [];
          let escaped = false;
          for (const seg of joined.split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') { if (parts.length === 0) { escaped = true; break; } parts.pop(); continue; }
            parts.push(seg);
          }
          if (escaped) { fail('D5', rel, l.line, `${JSON.stringify(dest)} leaves the repository`); continue; }
          target = parts.join('/');
          if (!tree.fileSet.has(target) && !tree.dirs.has(target)) { fail('D5', rel, l.line, `${JSON.stringify(dest)} — ${target} does not exist`); continue; }
        }
        if (frag !== '') {
          let f;
          try { f = decodeURIComponent(frag); } catch { fail('D5', rel, l.line, `bad escape in ${JSON.stringify(dest)}`); continue; }
          checkFragment(rel, l.line, target, f, dest);
        }
      }
    }
  }

  /* D6 — the reference manifest and structure */
  if (want('D6')) {
    for (const rel of mdFiles) {
      if (isHistory(rel)) continue;
      const d = loadDoc(rel);
      if (d.scan.unclosedFence !== null) fail('D6', rel, d.scan.unclosedFence, 'code fence opened here is never closed');
    }
    const refFiles = mdFiles.filter(isReference).map(baseOf).sort();
    const index = loadDoc(REFERENCE_INDEX);
    const listed = [];
    if (index) {
      const lines = index.text.split('\n');
      const start = lines.findIndex((l) => l.trim() === '<!-- chapters:start -->');
      const end = lines.findIndex((l) => l.trim() === '<!-- chapters:end -->');
      if (start < 0 || end < start) {
        fail('D6', REFERENCE_INDEX, 0, 'no <!-- chapters:start --> … <!-- chapters:end --> manifest');
      } else {
        for (const l of index.scan.links) {
          if (l.line <= start + 1 || l.line >= end + 1 || l.image) continue;
          const hashAt = l.dest.indexOf('#');
          const file = (hashAt >= 0 ? l.dest.slice(0, hashAt) : l.dest).replace(/^\.\//, '');
          if (file === '' || file.includes('/')) { fail('D6', REFERENCE_INDEX, l.line, `manifest entry ${JSON.stringify(l.dest)} is not a file in ${REFERENCE_DIR}`); continue; }
          listed.push({ file, line: l.line });
        }
      }
    }
    const listedNames = listed.map((x) => x.file);
    for (const x of listed) {
      if (listedNames.indexOf(x.file) !== listedNames.lastIndexOf(x.file) && listedNames.indexOf(x.file) !== listed.indexOf(x)) {
        fail('D6', REFERENCE_INDEX, x.line, `${x.file} is listed twice`);
      }
      if (!refFiles.includes(x.file)) fail('D6', REFERENCE_INDEX, x.line, `${x.file} is listed but missing`);
    }
    for (const f of refFiles) {
      if (!listedNames.includes(f)) fail('D6', `${REFERENCE_DIR}/${f}`, 0, 'not listed in the manifest — the printable builds from the manifest, so it would be dropped');
    }
    const order = listedNames.filter((f, i) => listedNames.indexOf(f) === i);
    for (let i = 1; i < order.length; i++) {
      if (order[i - 1] >= order[i]) fail('D6', REFERENCE_INDEX, listed.find((x) => x.file === order[i]).line, `${order[i]} is listed after ${order[i - 1]}; the manifest is in file-name order`);
    }
    const chapters = [];
    const appendices = [];
    let prev = null;
    for (const f of refFiles) {
      const rel = `${REFERENCE_DIR}/${f}`;
      const name = referenceName(f);
      if (!name) { fail('D6', rel, 0, 'not a reference file name (NN-slug.md, NN-k-slug.md or X-slug.md)'); prev = null; continue; }
      const d = loadDoc(rel);
      const first = d.scan.headings[0];
      const h2 = d.scan.headings.filter((h) => h.level <= 2);
      if (name.part >= 2) {
        if (!first || first.level !== 3) fail('D6', rel, first?.line ?? 0, `part ${name.part} of chapter ${name.chapter} must open with a ### heading`);
        if (h2.length) fail('D6', rel, h2[0].line, `a later part holds a level-${h2[0].level} heading`);
        if (!prev || prev.chapter !== name.chapter || prev.part !== name.part - 1) fail('D6', rel, 0, `part ${name.part} of chapter ${name.chapter} does not follow part ${name.part - 1}`);
      } else {
        const want2 = name.appendix ? `Appendix ${name.appendix}` : `${name.chapter}. `;
        if (!first || first.level !== 2 || !first.raw.startsWith(want2)) fail('D6', rel, first?.line ?? 0, `must open with "## ${want2.trim()}…"`);
        if (h2.length > 1) fail('D6', rel, h2[1].line, `a second level-${h2[1].level} heading; one chapter per file`);
        if (name.appendix) appendices.push(name.appendix); else chapters.push(name.chapter);
      }
      prev = name;
    }
    const wantChapters = Number(baselines?.reference?.chapters ?? NaN);
    const wantAppendices = Array.isArray(baselines?.reference?.appendices) ? baselines.reference.appendices : null;
    if (!Number.isInteger(wantChapters) || !wantAppendices) {
      fail('D6', BASELINES, 0, 'reference.chapters / reference.appendices are not set');
    } else {
      const expected = Array.from({ length: wantChapters }, (_, i) => i + 1).join(',');
      if (chapters.join(',') !== expected) fail('D6', REFERENCE_DIR, 0, `chapters ${chapters.join(',') || 'none'} — expected 1–${wantChapters}, each once`);
      if (appendices.join(',') !== wantAppendices.join(',')) fail('D6', REFERENCE_DIR, 0, `appendices ${appendices.join(',') || 'none'} — expected ${wantAppendices.join(',')}`);
    }
  }

  /* D7 — options.md against config.yaml */
  if (want('D7')) {
    const d = loadDoc(OPTIONS_PAGE);
    if (!d) fail('D7', OPTIONS_PAGE, 0, 'missing');
    if (!config) fail('D7', CONFIG_YAML, 0, 'missing');
    if (d && config) {
      for (const k of config.options.keys()) if (!config.schema.has(k)) fail('D7', CONFIG_YAML, 0, `${k} has a default but no schema`);
      for (const k of config.schema.keys()) if (!config.options.has(k)) fail('D7', CONFIG_YAML, 0, `${k} has a schema but no default`);
      const rows = new Map();
      for (const t of readTables(d.scan)) {
        const di = t.header.findIndex((h) => h.toLowerCase() === 'default');
        const si = t.header.findIndex((h) => h.toLowerCase() === 'schema');
        if (di < 0 || si < 0) continue;
        for (const r of t.rows) {
          const keyCell = r.cells[0] ?? '';
          const key = isSingleCode(keyCell) ? keyCell.trim().slice(1, -1) : null;
          if (!key || !isUpperToken(key) || key.includes('*')) { fail('D7', OPTIONS_PAGE, r.line, `row ${JSON.stringify(keyCell)} is not one backticked option key`); continue; }
          if (rows.has(key)) { fail('D7', OPTIONS_PAGE, r.line, `${key} has a second row (first at line ${rows.get(key).line})`); continue; }
          rows.set(key, { line: r.line, def: r.cells[di] ?? '', schema: r.cells[si] ?? '' });
        }
      }
      for (const [key, row] of rows) {
        if (!config.options.has(key)) { fail('D7', OPTIONS_PAGE, row.line, `${key} is not an option in ${CONFIG_YAML}`); continue; }
        const def = normalizeDefault(row.def);
        const cfgDef = config.options.get(key);
        if (!sameScalar(def, cfgDef)) fail('D7', OPTIONS_PAGE, row.line, `${key} default ${JSON.stringify(def)} ≠ config.yaml ${JSON.stringify(cfgDef)}`);
        const schema = normalizeSchema(row.schema);
        const cfgSchema = config.schema.get(key) ?? '';
        if (schema !== cfgSchema) fail('D7', OPTIONS_PAGE, row.line, `${key} schema ${JSON.stringify(schema)} ≠ config.yaml ${JSON.stringify(cfgSchema)}`);
      }
      for (const key of config.options.keys()) if (!rows.has(key)) fail('D7', OPTIONS_PAGE, 0, `${key} has no row`);
    }
  }

  /* D8 — ratchets and release headings */
  if (want('D8')) {
    const totals = { releaseParagraphs: 0, fileLineCitations: 0, sectionSigns: 0 };
    for (const rel of mdFiles.filter(isReference)) {
      const d = loadDoc(rel);
      const c = ratchetCounts(d.text, d.scan);
      for (const k of RATCHETS) totals[k] += c[k];
    }
    const base = baselines?.ratchet ?? {};
    for (const k of RATCHETS) {
      const expected = base[k];
      const actual = totals[k];
      if (!Number.isInteger(expected)) { fail('D8', BASELINES, 0, `ratchet.${k} is not set; the reference measures ${actual}`); continue; }
      if (actual !== expected) {
        fail('D8', REFERENCE_DIR, 0, actual < expected
          ? `${k} fell to ${actual} (baseline ${expected}): lower ratchet.${k} in ${BASELINES} to ${actual}`
          : `${k} rose to ${actual} (baseline ${expected}) — ${k === 'releaseParagraphs' ? 'release narrative goes in CHANGELOG.md' : k === 'fileLineCitations' ? 'cite function names, not file:line' : 'section numbers are being retired'}`);
      }
    }
    for (const rel of [...HA_SURFACES, ...mdFiles.filter((r) => isGuidePage(r) || isReference(r) || r === REFERENCE_INDEX)]) {
      const d = loadDoc(rel);
      if (!d) continue;
      for (const h of d.scan.headings) {
        if (RELEASE_HEADING.test(h.text)) fail('D8', rel, h.line, `heading "${h.text}" — release narrative lives in CHANGELOG.md and the Releases page`);
      }
    }
  }

  /* D9 — frozen history */
  if (want('D9')) {
    const pins = baselines?.history && typeof baselines.history === 'object' ? baselines.history : null;
    if (!pins) fail('D9', BASELINES, 0, 'history pins are not set');
    const present = mdFiles.filter(isHistory);
    for (const rel of tree.files.filter((f) => isHistory(f) && !present.includes(f))) fail('D9', rel, 0, 'docs/history holds only pinned Markdown');
    if (pins) {
      for (const rel of present) {
        if (!Object.hasOwn(pins, rel)) { fail('D9', rel, 0, `not pinned in ${BASELINES} history (sha256 ${sha256(loadDoc(rel).buf)})`); continue; }
      }
      for (const [rel, pin] of Object.entries(pins)) {
        const d = loadDoc(rel);
        if (!d) { fail('D9', rel, 0, 'pinned history file is missing'); continue; }
        const actual = sha256(d.buf);
        if (actual !== pin) fail('D9', rel, 0, pin ? `changed: sha256 ${actual}, pinned ${pin} — history is frozen; correct the reference instead` : `sha256 is not pinned (it is ${actual})`);
        const lines = d.text.split('\n');
        const quote = [];
        for (const l of lines) { if (!l.startsWith('>')) break; quote.push(l); }
        const banner = quote.join(' ').toLowerCase();
        if (lines[0] !== '> [!NOTE]' || !banner.includes('historical') || !banner.includes('superseded')) {
          fail('D9', rel, 1, 'must open with a "> [!NOTE]" banner saying it is historical and may be superseded');
        }
      }
    }
  }

  /* D10 — pointers into the old monolith; docs/…/*.md mentions */
  if (want('D10')) {
    const targets = tree.files.filter((rel) => !isChangelog(rel) && !isHistory(rel) && !SKIP_FILES.has(baseOf(rel))
      && TEXT_EXT.has(extOf(rel)) && (extOf(rel) !== '.md' || mdFiles.includes(rel)));
    for (const rel of targets) {
      const r = extOf(rel) === '.md' ? loadDoc(rel) : readOnce(root, rel);
      if (!r || r.size > 4 * 1024 * 1024) continue;
      if (extOf(rel) !== '.md' && r.buf.includes(0)) continue; // binary (a NUL in Markdown is D2's)
      const text = r.text ?? r.buf.toString('utf8');
      for (const m of text.matchAll(MONOLITH_POINTER)) {
        fail('D10', rel, lineOfIndex(text, m.index), `"${text.slice(m.index, m.index + m[0].length + 12).split('\n')[0]}…" points into the old single-file manual; name docs/reference/<file>.md and its heading`);
      }
      for (let i = text.indexOf('docs/'); i >= 0; i = text.indexOf('docs/', i + 1)) {
        const prev = text[i - 1];
        if (prev !== undefined && /^[A-Za-z0-9_.\/-]$/.test(prev)) {
          const before = text.slice(Math.max(0, i - 10), i);
          if (!(before.endsWith('blob/main/') || before.endsWith('tree/main/'))) continue;
        }
        let j = i + 5;
        while (j < text.length && /^[A-Za-z0-9_.\/-]$/.test(text[j])) j++;
        let mention = text.slice(i, j);
        while (mention.endsWith('.')) mention = mention.slice(0, -1);
        if (!mention.endsWith('.md')) continue;
        if (!tree.fileSet.has(mention)) fail('D10', rel, lineOfIndex(text, i), `${mention} does not exist`);
      }
    }
  }

  /* D11 — the write list */
  if (want('D11')) {
    const d = loadDoc(GUIDE);
    if (d) {
      const h = d.scan.headings.find((x) => x.level === 2 && x.text === WRITE_SECTION);
      if (!h) {
        fail('D11', GUIDE, 0, `no "## ${WRITE_SECTION}" section`);
      } else {
        const next = d.scan.headings.find((x) => x.line > h.line && x.level <= 2);
        const end = next ? next.line : Infinity;
        // Only the row labels count: the first cell of each row of a table inside the section. The
        // section's prose repeats some phrases ("set the reserve floor"), so a whole-text match
        // let a writer's row go with the check still green.
        const tables = readTables(d.scan).filter((t) => t.line > h.line && t.line < end);
        const labels = tables.flatMap((t) => t.rows.map((r) => r.cells[0] ?? ''));
        for (const [fn, phrases] of Object.entries(WRITERS)) {
          for (const p of phrases) {
            const bold = `**${p}**`;
            if (!labels.some((label) => label.includes(bold))) {
              fail('D11', GUIDE, h.line, `the write table does not name "${p}" (${fn} in server/src/ecoflow/commands.ts) in bold in a row's first cell`);
            }
          }
        }
      }
    }
  }

  return { violations, notes, checked: mdFiles.length };
}

/* ─────────────────────────────── inventory ─────────────────────────────── */

/** Blank-line-separated blocks of a section (a fenced block stays whole). */
function blocksOf(text) {
  const scan = scanMarkdown(text);
  const out = [];
  let cur = [];
  let start = 1;
  scan.lines.forEach((l, i) => {
    const kind = scan.lineKinds[i];
    const inFence = kind === 'fence-open' || kind === 'fence-body' || kind === 'fence-close';
    if (l.trim() === '' && !inFence) {
      if (cur.length) out.push({ line: start, text: cur.join('\n') });
      cur = [];
      start = i + 2;
      return;
    }
    if (!cur.length) start = i + 1;
    cur.push(l);
  });
  if (cur.length) out.push({ line: start, text: cur.join('\n') });
  return out;
}

/**
 * Account for every section of `oldPath` in `newPaths`. Returns a report object; `ok` is true
 * when every old section appears exactly once, byte-identical.
 */
export function inventory(oldPath, newPaths) {
  const read = (p) => readFileSync(p).toString('utf8');
  const oldText = read(oldPath);
  const old = splitSections(oldText);
  const news = newPaths.map((p) => {
    const text = read(p);
    return { path: p, text, ...splitSections(text) };
  });
  const byHash = new Map();
  for (const n of news) {
    const add = (s, heading, line) => {
      const h = sha256(Buffer.from(s, 'utf8'));
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push({ file: n.path, heading, line });
    };
    if (n.preamble !== '') add(n.preamble, '(preamble)', 1);
    for (const s of n.sections) add(s.text, s.path, s.line);
  }
  const allNew = news.map((n) => n.text).join('\n');
  const rows = [];
  const claimed = new Set();
  const oldSections = [
    ...(old.preamble !== '' ? [{ path: '(preamble)', line: 1, text: old.preamble }] : []),
    ...old.sections,
  ];
  for (const s of oldSections) {
    const hash = sha256(Buffer.from(s.text, 'utf8'));
    const bytes = Buffer.byteLength(s.text);
    const hits = byHash.get(hash) ?? [];
    for (const hit of hits) claimed.add(`${hit.file}#${hit.line}`);
    if (hits.length === 1) { rows.push({ status: 'same', path: s.path, line: s.line, bytes, hash, at: hits }); continue; }
    if (hits.length > 1) { rows.push({ status: 'duplicated', path: s.path, line: s.line, bytes, hash, at: hits }); continue; }
    const missing = [];
    let accounted = 0;
    for (const b of blocksOf(s.text)) {
      const bb = Buffer.byteLength(b.text);
      if (allNew.includes(b.text)) accounted += bb;
      else missing.push({ line: s.line + b.line - 1, bytes: bb, text: b.text.length > 100 ? `${b.text.slice(0, 100)}…` : b.text });
    }
    rows.push({ status: 'changed', path: s.path, line: s.line, bytes, hash, accounted, missing });
  }
  const added = [];
  for (const n of news) {
    if (n.preamble !== '' && !claimed.has(`${n.path}#1`)) added.push({ file: n.path, line: 1, path: '(preamble)', bytes: Buffer.byteLength(n.preamble) });
    for (const s of n.sections) {
      if (!claimed.has(`${n.path}#${s.line}`)) added.push({ file: n.path, line: s.line, path: s.path, bytes: Buffer.byteLength(s.text) });
    }
  }
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const totals = {
    oldBytes: Buffer.byteLength(oldText),
    newBytes: sum(news, (n) => Buffer.byteLength(n.text)),
    sections: rows.length,
    same: rows.filter((r) => r.status === 'same').length,
    sameBytes: sum(rows.filter((r) => r.status === 'same'), (r) => r.bytes),
    changed: rows.filter((r) => r.status === 'changed').length,
    duplicated: rows.filter((r) => r.status === 'duplicated').length,
    blockAccountedBytes: sum(rows.filter((r) => r.status === 'changed'), (r) => r.accounted),
    unaccountedBytes: sum(rows.filter((r) => r.status === 'changed'), (r) => sum(r.missing, (m) => m.bytes)),
    addedSections: added.length,
    addedBytes: sum(added, (a) => a.bytes),
  };
  return { ok: totals.changed === 0 && totals.duplicated === 0, totals, rows, added };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

function main(argv) {
  if (argv.includes('--inventory')) {
    const i = argv.indexOf('--inventory');
    const sep = argv.indexOf('--');
    const oldPath = argv[i + 1];
    const newPaths = sep > i ? argv.slice(sep + 1) : [];
    if (!oldPath || oldPath === '--' || newPaths.length === 0) {
      console.error('usage: node scripts/check-docs.mjs --inventory <old.md> -- <new.md…> [--json]');
      process.exit(2);
    }
    const rep = inventory(oldPath, newPaths);
    if (argv.slice(0, sep).includes('--json')) {
      console.log(JSON.stringify(rep, null, 2));
    } else {
      const t = rep.totals;
      for (const r of rep.rows) {
        if (r.status === 'same') continue;
        console.log(`${r.status.toUpperCase()} ${r.path} (old line ${r.line}, ${r.bytes} B)`);
        if (r.status === 'duplicated') for (const a of r.at) console.log(`    at ${a.file}:${a.line}`);
        if (r.status === 'changed') {
          console.log(`    ${r.accounted} B found block by block; ${r.bytes - r.accounted} B not found:`);
          for (const m of r.missing) console.log(`    old line ${m.line} (${m.bytes} B): ${JSON.stringify(m.text)}`);
        }
      }
      for (const a of rep.added) console.log(`NEW ${a.file}:${a.line} ${a.path} (${a.bytes} B)`);
      console.log(`inventory: ${t.sections} old sections — ${t.same} byte-identical (${t.sameBytes} B), ${t.changed} changed, ${t.duplicated} duplicated; `
        + `old ${t.oldBytes} B, new ${t.newBytes} B; changed sections: ${t.blockAccountedBytes} B found by block, ${t.unaccountedBytes} B not found; `
        + `${t.addedSections} new section(s), ${t.addedBytes} B`);
    }
    process.exit(rep.ok ? 0 : 1);
  }
  if (argv.includes('--slugs')) {
    const file = argv[argv.indexOf('--slugs') + 1];
    const scan = scanMarkdown(readFileSync(file).toString('utf8'));
    for (const h of scan.headings) console.log(`${h.line}\t${'#'.repeat(h.level)}\t${h.slug}${h.slug !== h.base ? `\t(base ${h.base})` : ''}\t${h.text}`);
    return;
  }
  if (argv.includes('--check')) {
    const ri = argv.indexOf('--root');
    const root = ri >= 0 ? resolve(argv[ri + 1]) : REPO;
    const oi = argv.indexOf('--only');
    const only = oi >= 0 ? argv[oi + 1].split(',').map((s) => s.trim().toUpperCase()) : null;
    const { violations, notes, checked } = runChecks(root, { only });
    for (const n of notes) console.log(`note: ${n}`);
    for (const v of violations) console.error(`${v.rule} ${v.file}${v.line ? `:${v.line}` : ''}: ${v.message}`);
    if (violations.length) {
      console.error(`check-docs: ${violations.length} violation(s) across ${checked} Markdown file(s).`);
      process.exit(1);
    }
    console.log(`check-docs: ${checked} Markdown file(s), rules ${only ? only.join(',') : 'D1–D11'}: no violations.`);
    return;
  }
  console.error('usage: node scripts/check-docs.mjs --check [--root <dir>] [--only D1,D5] | --inventory <old> -- <new…> [--json] | --slugs <file>');
  process.exit(2);
}

/** Is this module the script node was asked to run? (See roll-changelog.mjs: compare real paths.) */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  let real;
  try { real = realpathSync(entry); } catch { real = resolve(entry); }
  return real === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) main(process.argv.slice(2));
