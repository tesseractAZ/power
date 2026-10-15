/**
 * v1.188.0 — the documentation, read the way scripts/check-docs.mjs and the printable read it.
 *
 * The engineering reference was one file, ecoflow_panel/DOCS.md, until v1.188.0 moved it into
 * docs/reference/ (one file per chapter or part, listed in order by the manifest in the index,
 * docs/reference/README.md) and made DOCS.md the operator guide. A test that pins what the
 * reference says about the code finds its section here BY HEADING, never by file name: when a
 * file outgrows its budget it is split at a `###` heading into the next part, and a test that
 * named the old file would stop finding the heading it reads.
 *
 * Headings are found with the fence-aware scanner (scripts/lib/markdownScan.mjs), so a heading
 * quoted inside a code block is not a heading. A lookup must match exactly one heading across the
 * manifest's files, and the failure names every file that matched: a heading two files carry is
 * ambiguous, and one that none carries was renamed or dropped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const REFERENCE_DIR = 'docs/reference';
export const REFERENCE_INDEX = `${REFERENCE_DIR}/README.md`;
export const ENTITIES_PAGE = 'docs/guide/entities.md';
const MANIFEST_START = '<!-- chapters:start -->';
const MANIFEST_END = '<!-- chapters:end -->';

interface Heading { line: number; level: number; raw: string }
interface Link { line: number; image: boolean; dest: string }
interface Table { line: number; header: string[]; rows: { line: number; cells: string[] }[] }
interface Scan { headings: Heading[]; links: Link[] }
interface MarkdownScan {
  scanMarkdown(src: string): Scan;
  readTables(scan: Scan): Table[];
}
const ms = (await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'markdownScan.mjs')).href)) as MarkdownScan;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The reference files in the manifest's order (repository-relative): the links between the
 *  chapters markers of the index, one per line, as check-docs.mjs D6 and the printable read them. */
export function referenceFiles(): string[] {
  const text = read(REFERENCE_INDEX);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === MANIFEST_START);
  const end = lines.findIndex((l) => l.trim() === MANIFEST_END);
  assert.ok(start >= 0 && end > start, `${REFERENCE_INDEX} has no ${MANIFEST_START} … ${MANIFEST_END} manifest`);
  const files = ms.scanMarkdown(text).links
    .filter((l) => !l.image && l.line > start + 1 && l.line < end + 1)
    .map((l) => l.dest.split('#')[0]);
  assert.ok(files.length > 0, `the ${REFERENCE_INDEX} manifest lists no file`);
  for (const f of files) {
    assert.ok(f.endsWith('.md') && !f.includes('/'), `manifest entry ${JSON.stringify(f)} is not a file in ${REFERENCE_DIR}`);
  }
  assert.equal(new Set(files).size, files.length, `the ${REFERENCE_INDEX} manifest lists a file twice`);
  return files.map((f) => `${REFERENCE_DIR}/${f}`);
}

export interface ReferenceSection {
  /** Repository-relative path of the reference file that holds the section. */
  file: string;
  /** 1-based line of the section's heading in that file. */
  line: number;
  /** The heading line through the line before the next heading of the same or a higher level. */
  text: string;
}

/**
 * The section of the engineering reference that opens with the heading `level` × `#` + ` ` +
 * `heading` (for example 3, '9. Delivery surfaces'), up to the next heading of the same or a
 * higher level or the end of its file. Exactly one heading in the manifest's files may match.
 */
export function referenceSection(level: number, heading: string): ReferenceSection {
  const hits: ReferenceSection[] = [];
  for (const file of referenceFiles()) {
    const text = read(file);
    const { headings } = ms.scanMarkdown(text);
    const lines = text.split('\n');
    headings.forEach((h, i) => {
      if (h.level !== level || h.raw !== heading) return;
      const next = headings.slice(i + 1).find((x) => x.level <= level);
      hits.push({ file, line: h.line, text: lines.slice(h.line - 1, next ? next.line - 1 : undefined).join('\n') });
    });
  }
  const where = hits.map((s) => `${s.file}:${s.line}`).join(', ');
  assert.equal(hits.length, 1,
    `"${'#'.repeat(level)} ${heading}" must open exactly one section of the reference; found ${hits.length}${where ? ` (${where})` : ''}`);
  return hits[0];
}

/**
 * The rows of docs/guide/entities.md, keyed by the unique_id cell (backticks removed): every
 * table whose header has a `unique_id` column. A unique_id with two rows fails here.
 */
export function entityRows(): Map<string, { line: number; cells: string[]; text: string }> {
  const text = read(ENTITIES_PAGE);
  const lines = text.split('\n');
  const rows = new Map<string, { line: number; cells: string[]; text: string }>();
  for (const t of ms.readTables(ms.scanMarkdown(text))) {
    const col = t.header.findIndex((h) => h.toLowerCase() === 'unique_id');
    if (col < 0) continue;
    for (const r of t.rows) {
      const cell = r.cells[col] ?? '';
      const id = cell.startsWith('`') && cell.endsWith('`') ? cell.slice(1, -1) : cell;
      assert.ok(!rows.has(id), `${ENTITIES_PAGE}:${r.line}: ${id} has a second row (first at line ${rows.get(id)?.line})`);
      rows.set(id, { line: r.line, cells: r.cells, text: lines[r.line - 1] });
    }
  }
  return rows;
}
