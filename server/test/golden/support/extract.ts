import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Run a module's PRIVATE top-level declarations without editing the module.
 *
 * Several of the helpers the goldens pin are private (`fmtPhoenixClock` and `clampInt` in
 * index.ts, `guessProductFromName` in snapshot.ts, `apsCent` and the limit constants in
 * analytics.ts). index.ts cannot be imported at all — it starts the server — and the goldens
 * must be captured on the UNCHANGED tree, so adding `export` first would itself be an edit of
 * the tree the goldens describe. This slices each named declaration out of the source text,
 * writes them into a temporary module with `export` in front, and imports that module through
 * the same loader the tests run under. The code that runs is the module's own text; only its
 * visibility changes.
 *
 * Declarations are emitted in the order given, so list a `const` before the functions that use
 * it (function declarations are hoisted, `const` is not). A declaration may refer only to the
 * other listed names, to globals and to its own parameters; the slicer does not follow imports.
 * A name that is not found exactly once is an error: a moved helper must be re-wired, never
 * silently skipped.
 */
export async function extractDecls<T = Record<string, unknown>>(
  absFile: string,
  names: string[],
  prelude = '',
): Promise<T> {
  const src = readFileSync(absFile, 'utf8');
  const parts: string[] = [];
  for (const name of names) parts.push(sliceDecl(src, name, absFile));
  const dir = mkdtempSync(join(tmpdir(), 'golden-extract-'));
  const file = join(dir, `${basename(absFile).replace(/\.[cm]?[tj]s$/, '')}.extract.mts`);
  writeFileSync(file, `${prelude}\n${parts.map((p) => `export ${p}`).join('\n\n')}\n`);
  return (await import(pathToFileURL(file).href)) as T;
}

const memo = new Map<string, Promise<unknown>>();
/** `extractDecls`, memoized on (file, names): for helpers that read process.env at CALL time, one
 *  extracted copy serves every environment variant. Module-level constants that read the environment
 *  at import time must use `extractDecls` directly so each variant gets a fresh evaluation. */
export function extractDeclsCached<T = Record<string, unknown>>(absFile: string, names: string[]): Promise<T> {
  const key = `${absFile}\u0000${names.join(',')}`;
  let p = memo.get(key);
  if (!p) { p = extractDecls<T>(absFile, names); memo.set(key, p); }
  return p as Promise<T>;
}

/** The source text of one top-level `function NAME` / `const NAME` declaration (without `export`). */
export function sliceDecl(src: string, name: string, label = '<source>'): string {
  const re = new RegExp(`^(?:export\\s+)?((?:async\\s+)?function\\s+${name}\\b|const\\s+${name}\\b)`, 'gm');
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`${label}: expected exactly one top-level declaration of ${name}, found ${hits.length}`);
  }
  const m = hits[0];
  const start = m.index! + m[0].length - m[1].length; // drop a leading `export `
  const isFn = m[1].startsWith('function') || m[1].startsWith('async');
  const end = isFn ? endOfFunction(src, start) : endOfStatement(src, start);
  return src.slice(start, end).trimEnd();
}

/* A small scanner that understands strings, template literals, comments and regex literals well
 * enough to balance brackets in this codebase's helpers. */
interface Scan { i: number; depth: number }

function skipAtoms(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n < 0 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); return n < 0 ? src.length : n + 2; }
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { j = balanced(src, j + 1) ; continue; }
      j++;
    }
    return j + 1;
  }
  if (c === '/' && regexCanStart(src, i)) {
    let j = i + 1; let inClass = false;
    while (j < src.length) {
      const d = src[j];
      if (d === '\\') { j += 2; continue; }
      if (d === '[') inClass = true;
      else if (d === ']') inClass = false;
      else if (d === '/' && !inClass) break;
      else if (d === '\n') return i + 1; // not a regex after all
      j++;
    }
    j++;
    while (j < src.length && /[a-z]/.test(src[j])) j++;
    return j;
  }
  return i;
}

function regexCanStart(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  const prev = src[k];
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, k - 20), k + 1))?.[1];
  return word === 'return' || word === 'typeof' || word === 'case' || word === 'in' || word === 'of';
}

/** Index just past the bracket group that opens at `open`. */
function balanced(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const j = skipAtoms(src, i);
    if (j !== i) { i = j; continue; }
    const c = src[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i;
}

function skipWs(src: string, i: number): number {
  while (i < src.length) {
    const j = skipAtoms(src, i);
    if (j !== i && (src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) { i = j; continue; }
    if (/\s/.test(src[i])) { i++; continue; }
    break;
  }
  return i;
}

/** Index just past the `>` that closes the generic group opening at `open` (`=>` is not a close). */
function skipAngle(src: string, open: number): number {
  let depth = 0; let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '<') depth++;
    else if (c === '>' && src[i - 1] !== '=') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/** Is the `{` at `j` still part of a type (after `:` `|` `&` `,` `(` `<` `=>`), not the body? */
function typeContinues(src: string, j: number): boolean {
  let k = j - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return false;
  return /[:|&,(<=]/.test(src[k]);
}

function endOfFunction(src: string, start: number): number {
  let i = start;
  while (i < src.length && src[i] !== '(') { if (src[i] === '<') { i = skipAngle(src, i); continue; } i++; }
  i = balanced(src, i); // just past the parameter list
  let j = skipWs(src, i);
  if (src[j] === ':') {
    j++;
    for (;;) {
      j = skipWs(src, j);
      const c = src[j];
      if (c === undefined) throw new Error('function body not found');
      if (c === '{') { if (typeContinues(src, j)) { j = balanced(src, j); continue; } break; }
      if (c === '(' || c === '[') { j = balanced(src, j); continue; }
      if (c === '<') { j = skipAngle(src, j); continue; }
      if (c === "'" || c === '"' || c === '`') { j = skipAtoms(src, j); continue; }
      if (c === '=' && src[j + 1] === '>') { j += 2; continue; }
      if (/[\w$.|&?!]/.test(c)) { j++; continue; }
      break;
    }
  }
  const body = src.indexOf('{', j);
  if (body < 0) throw new Error('function body not found');
  return balanced(src, body);
}

function endOfStatement(src: string, start: number): number {
  let i = start;
  const s: Scan = { i, depth: 0 };
  while (s.i < src.length) {
    const j = skipAtoms(src, s.i);
    if (j !== s.i) { s.i = j; continue; }
    const c = src[s.i];
    if (c === '(' || c === '[' || c === '{') { s.i = balanced(src, s.i); continue; }
    if (c === ';') return s.i + 1;
    if (c === '\n' && /^\s*\n/.test(src.slice(s.i)) ) { /* blank line inside a statement is fine */ }
    s.i++;
  }
  i = s.i;
  return i;
}
