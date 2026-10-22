import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (lane A, T18) — the site-zone literal ratchet.
 *
 * Before v1.191.0 the zone 'America/Phoenix' was written out at 38 places in 10 files (server and
 * web): every one a second source of truth beside the host clock and the fixed UTC−7 arithmetic.
 * siteTime.ts now resolves one site zone (SITE_TIMEZONE → TZ → the default), and the default is the
 * ONE copy of the literal, `DEFAULT_SITE_TIME_ZONE` in config.ts.
 *
 *   1. No string literal 'America/Phoenix' in code outside config.ts, in server/src or web/src.
 *   2. Mentions in comments may stay (they explain the reference install), but their number per
 *      file may only fall: lower MENTIONS when it does.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = { server: resolve(HERE, '../src'), web: resolve(HERE, '../../web/src') };
const ZONE = 'America/Phoenix';
const ALLOWED_LITERAL = 'server/config.ts';

/** Mentions (code and comments) per file, measured when lane A landed. Lower when one falls; never raise. */
export const MENTIONS: Record<string, number> = {
  'server/analytics.ts': 2,
  'server/config.ts': 3,
  'server/haStatistics.ts': 1,
  'server/nightChargeActuator.ts': 1,
  'server/recorder.ts': 4,
  'server/siteTime.ts': 7,
  'server/tariff.ts': 1,
};
/** Code literals allowed per file: only the default in config.ts. */
export const LITERALS: Record<string, number> = {
  'server/config.ts': 1,
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(e)) out.push(p);
  }
  return out.sort();
}

/** The code part of a line: a JSDoc / block-comment line is all comment; a trailing `//` comment
 *  (not the `//` of a URL inside a string) is dropped. */
export function codeOf(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return '';
  const m = /(^|[^:])\/\//.exec(line);
  return m ? line.slice(0, m.index + m[1].length) : line;
}

export function measure(): { mentions: Map<string, number>; literals: Map<string, number> } {
  const mentions = new Map<string, number>();
  const literals = new Map<string, number>();
  for (const [label, root] of Object.entries(ROOTS)) {
    for (const abs of walk(root)) {
      const rel = `${label}/${relative(root, abs)}`;
      const text = readFileSync(abs, 'utf8');
      let m = 0; let l = 0;
      for (const line of text.split('\n')) {
        m += line.split(ZONE).length - 1;
        l += (codeOf(line).match(/(['"`])America\/Phoenix\1/g) ?? []).length;
      }
      if (m) mentions.set(rel, m);
      if (l) literals.set(rel, l);
    }
  }
  return { mentions, literals };
}

test('★ T18: no America/Phoenix string literal in code outside config.ts (the default), beyond the shrinking list', () => {
  const { literals } = measure();
  const over: string[] = [];
  for (const [file, n] of literals) if (n > (LITERALS[file] ?? 0)) over.push(`${file}: ${n} literal(s), ${LITERALS[file] ?? 0} allowed`);
  assert.deepEqual(over, [], 'the zone is siteTime.ts siteTimeZone(); the only literal is config.ts DEFAULT_SITE_TIME_ZONE');
  const stale = Object.entries(LITERALS).filter(([file, n]) => (literals.get(file) ?? 0) < n).map(([f, n]) => `${f}: ${literals.get(f) ?? 0} < ${n}`);
  assert.deepEqual(stale, [], 'a literal was removed — lower LITERALS so the ratchet holds there');
  assert.equal(literals.get(ALLOWED_LITERAL), 1, 'config.ts carries the default exactly once');
});

test('★ T18: mentions of the zone per file never increase (comments included)', () => {
  const { mentions } = measure();
  const over = [...mentions].filter(([f, n]) => n > (MENTIONS[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${MENTIONS[f] ?? 0}`);
  assert.deepEqual(over, [], 'a new mention of the literal zone: name the site zone instead (siteTime.ts)');
  const under = Object.entries(MENTIONS).filter(([f, n]) => (mentions.get(f) ?? 0) < n).map(([f, n]) => `${f}: ${mentions.get(f) ?? 0} < ${n}`);
  assert.deepEqual(under, [], 'the count fell — lower MENTIONS in this test to the new figures');
});

test('the comment filter keeps code and URLs, drops comments', () => {
  assert.equal(codeOf("  const z = 'America/Phoenix'; // the zone"), "  const z = 'America/Phoenix'; ");
  assert.equal(codeOf(' * e.g. \'America/Phoenix\''), '');
  assert.equal(codeOf("  fetch('http://supervisor/core/api') // note"), "  fetch('http://supervisor/core/api') ");
});
