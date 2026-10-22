/**
 * processEnvScan.ts — the scanner behind processEnvRatchet.test.ts: what every module outside config.ts
 * reads from the environment, by every route the review found (see that test). Not a test file, so the
 * manifest can be regenerated without running the suite:
 *
 *   cd server && node --import tsx test/processEnvScan.ts --write
 *
 * then read the diff of test/processEnvReads.json: it may only remove.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
export const MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'processEnvReads.json');

/** Measured at the S2 commit (v1.191.0 base 725db3b + config.ts: 292/274/62/217), lowered by the lanes as they merged (A: S3c paths in its files; B: the tariff readers; D: BATTERY_SOC_MAX_DROP_PCT in ecoflow/project.ts, SELF_HEAL_MIN_DEVICES; E: the plant limits and the index.ts ARB_* readers). Lower when the count falls; never raise. names counts the helper-read names too (14 more than the textual count saw), and since v1.191.0 review 3 the names read through the three environment parameters (6 more: the four SYSTEM_OUTAGE_* names, TUI_PASSWORD and TUI_USERNAME; a measurement, not new reads). */
export const BASELINE = { occurrences: 234, lines: 217, files: 57, names: 199 };

/** The helpers that read `process.env[name]` with a computed name, by file; their literal first
 *  arguments are the names they read. The list shrinks and never grows. */
export const DYNAMIC_READERS: Record<string, string> = {
  'selfVitals.ts': 'num',
  'hostThermal.ts': 'num',
  'ml.ts': 'gateEnvNum',
};

export const ENV_PARAM_ALLOWLIST: Record<string, number> = {
  'alerts.ts': 1,          // resolveOutageAlertOptions(env: Record<string, string | undefined>)
  'telnet/session.ts': 1,  // authFromEnv(env: NodeJS.ProcessEnv = process.env)
  'backupWindow.ts': 1,    // resolveBackupJournalPath({ env?: NodeJS.ProcessEnv })
};
export const PERMANENT_EXCEPTION = 'backupHook.mjs';

/** Any spelling of the environment object: process.env, process?.env, process['env']. */
const ACCESS = String.raw`\bprocess\s*(?:\?\.|\.)\s*env\b|\bprocess\s*(?:\?\.\s*)?\[\s*['"\`]env['"\`]\s*\]`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const accessRe = () => new RegExp(ACCESS, 'g');
const staticNameRe = () => new RegExp(String.raw`(?:${ACCESS})\s*(?:(?:\?\.|\.)\s*(${NAME})|(?:\?\.\s*)?\[\s*['"\`](${NAME})['"\`]\s*\])`, 'g');
const dynamicRe = () => new RegExp(String.raw`(?:${ACCESS})\s*(?:\?\.\s*)?\[\s*(?!['"\`])`, 'g');
const bareRe = () => new RegExp(String.raw`(?:${ACCESS})(?!\s*(?:\?\.|\.|\[))`, 'g');
/** An environment-typed parameter or field: the indirect reader. */
export const ENV_TYPE_RE = /\bProcessEnv\b|Record<\s*string\s*,\s*string\s*\|\s*undefined\s*>|\{\s*\[\s*\w+\s*:\s*string\s*\]\s*:\s*string\s*\|\s*undefined\s*\}|Partial<\s*Record<\s*string\s*,\s*string\s*>\s*>|typeof\s+process\s*\.\s*env\b/g;

/**
 * v1.191.0 (review 3) — the identifiers an environment-typed parameter or field binds (`env` in each of
 * the three listed readers), and a local that takes such a field (`const env = opts.env ?? process.env`).
 * The names read through them are pinned like any `process.env` read: the parameter rule (the
 * allowlist) bounded how many such readers exist, not what they read, so a new knob added inside
 * resolveOutageAlertOptions passed the ratchet.
 */
export function envParamIdents(text: string): string[] {
  const ids = new Set<string>();
  const typed = new RegExp(String.raw`([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:NodeJS\s*\.\s*)?(?:${ENV_TYPE_RE.source})`, 'g');
  for (const m of text.matchAll(typed)) ids.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\b/g)) {
    if (ids.has(m[2])) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** Forms that reach the environment without spelling `process.env` at the use: never allowed. */
export const FORBIDDEN: Array<[string, RegExp]> = [
  ['imports process', /\bfrom\s*['"](?:node:)?process['"]|\b(?:require|import)\s*\(\s*['"](?:node:)?process['"]\s*\)/],
  ['destructures process', /\}\s*=\s*(?:globalThis\s*(?:\?\.|\.)\s*)?process\b(?!\s*(?:\?\.|\.|\[))/],
  ['aliases process', /(?:[=:(,]|\?\?|\|\|)\s*(?:globalThis\s*(?:\?\.|\.)\s*)?process\s*(?:[;,)]|$)/m],
  ['indexes by the string process', /\[\s*['"`]process['"`]\s*\]/],
];

/** The source with comments removed (for the forbidden forms only; a comment cannot read anything). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|mjs|js)$/.test(e)) out.push(p);
  }
  return out.sort();
}

export interface FileReads { occurrences: number; lines: number; names: string[]; bare: number; dynamic: number }

/** What one module reads from the environment. PURE over its text; `helper` names its dynamic reader. */
export function readsOf(text: string, helper?: string): FileReads & { problems: string[] } {
  const problems: string[] = [];
  let occurrences = 0; let lines = 0;
  for (const line of text.split('\n')) {
    const n = (line.match(accessRe()) ?? []).length;
    if (n > 0) { lines += 1; occurrences += n; }
  }
  const names = new Set<string>();
  for (const m of text.matchAll(staticNameRe())) names.add(m[1] ?? m[2]);
  const dynamic = (text.match(dynamicRe()) ?? []).length;
  if (dynamic > 0) {
    if (!helper) problems.push(`process.env[<expression>] outside a listed helper (${dynamic}): read the key through config.ts`);
    else {
      const calls = new RegExp(String.raw`(?<!function\s+)\b${helper}\s*\(\s*(['"\`]?)`, 'g');
      for (const m of text.matchAll(calls)) {
        if (m[1] === '') problems.push(`${helper}(…) is called with a computed name: only a string literal is a pinned read`);
      }
      for (const m of text.matchAll(new RegExp(String.raw`(?<!function\s+)\b${helper}\s*\(\s*['"\`](${NAME})['"\`]`, 'g'))) names.add(m[1]);
    }
  }
  const code = stripComments(text);
  for (const [what, re] of FORBIDDEN) if (re.test(code)) problems.push(`${what}: reach the environment through config.ts`);
  // v1.191.0 (review 3) — the names read through an environment parameter (envParamIdents).
  for (const id of envParamIdents(code)) {
    const ref = String.raw`\b${id.replace(/\$/g, '\\$')}\s*`;
    for (const m of code.matchAll(new RegExp(String.raw`${ref}(?:\?\.|\.)\s*(${NAME})|${ref}(?:\?\.\s*)?\[\s*['"\`](${NAME})['"\`]\s*\]`, 'g'))) names.add(m[1] ?? m[2]);
    if (new RegExp(String.raw`${ref}(?:\?\.\s*)?\[\s*(?!['"\`])`).test(code)) problems.push(`${id}[<expression>]: a computed name read through an environment parameter; read the key through config.ts`);
    if (new RegExp(String.raw`\}\s*=\s*(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)?${id.replace(/\$/g, '\\$')}\b(?!\s*(?:\?\.|\.|\[))`).test(code)) problems.push(`destructures the environment parameter ${id}: its names are not pinned; read them as ${id}.NAME`);
  }
  return { occurrences, lines, names: [...names].sort(), bare: (text.match(bareRe()) ?? []).length, dynamic, problems };
}

export function measure(): { occurrences: number; lines: number; files: number; names: number; perFile: Map<string, number>; nameSet: Set<string>; byFile: Record<string, FileReads>; problems: string[] } {
  let occurrences = 0; let lines = 0;
  const perFile = new Map<string, number>();
  const nameSet = new Set<string>();
  const byFile: Record<string, FileReads> = {};
  const problems: string[] = [];
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs);
    if (rel === 'config.ts') continue;
    const r = readsOf(readFileSync(abs, 'utf8'), DYNAMIC_READERS[rel]);
    for (const p of r.problems) problems.push(`${rel}: ${p}`);
    if (r.occurrences === 0 && r.names.length === 0) continue;
    const { problems: _, ...reads } = r;
    byFile[rel] = reads;
    perFile.set(rel, r.occurrences);
    occurrences += r.occurrences; lines += r.lines;
    for (const n of r.names) nameSet.add(n);
  }
  return { occurrences, lines, files: perFile.size, names: nameSet.size, perFile, nameSet, byFile, problems };
}


/** The manifest the tree is pinned to (processEnvReads.json), as written by --write. */
export function manifestOf(byFile: Record<string, FileReads>): string {
  const out: Record<string, unknown> = { _how: 'Regenerate: cd server && node --import tsx test/processEnvScan.ts --write. The diff may only remove (processEnvRatchet.test.ts).' };
  for (const rel of Object.keys(byFile).sort()) out[rel] = byFile[rel];
  return `${JSON.stringify(out, null, 1)}\n`;
}

if (process.argv.includes('--write')) {
  const m = measure();
  if (m.problems.length) { console.error(m.problems.join('\n')); process.exit(1); }
  writeFileSync(MANIFEST_PATH, manifestOf(m.byFile));
  console.log(`processEnvReads.json: ${m.files} files, ${m.occurrences} occurrences, ${m.lines} lines, ${m.names} names`);
}
