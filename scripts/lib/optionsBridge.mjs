/**
 * optionsBridge.mjs — the rules of the options → environment bridge, as pure functions over the
 * add-on manifest and the run script. Shared by server/test/optionsEnvBridge.test.ts (which holds the
 * real files to them) and runnable against fixtures.
 *
 * The bridge (plan 2.3): config.yaml `schema:` → the run script → the environment → config.ts OPTIONS.
 *   - A key with an `options:` default is exported unconditionally, in one of three conventions the
 *     run script already uses: `export KEY=1|0`, `export KEY=true|false`, or verbatim
 *     `export KEY="$(bashio::config 'KEY')"`. The convention must match the reader's rule (config.ts
 *     `exportForm`): exporting "false" to a reader that tests `!== '0'` turns the option ON.
 *   - A schema-only key (declared in `schema:` as optional `?`, no `options:` default — the form every
 *     new v1.191.0 key takes) may be exported ONLY as
 *         if bashio::config.has_value 'KEY'; then export KEY="$(bashio::config 'KEY')"; fi
 *     so an unset key leaves the variable ABSENT and the code takes its current path. A bare export of
 *     a cleared optional field would put the string "null" into the environment.
 *     v1.191.0 (review) — and that line is the key's ONLY appearance in the script: any other line
 *     naming it (an indented export inside another block, an unquoted export, `KEY=…; export KEY`, a
 *     second copy) is a violation, whatever its spelling. bashio::config returns "null" for a missing
 *     key, so each of those exports the string "null" whenever the field is cleared.
 *   v1.191.0 (review 3) — every key, defaulted or not:
 *   - is assigned or exported in ONE place, its export block (the verbatim line, the has_value line, or
 *     the `if bashio::config.true 'KEY'` block). In bash the later export wins, so a second
 *     `export NOTIFY_CRITICAL_BYPASS_DND=false` turns the DND bypass on whatever the option says.
 *   - has that block at the top level of the script, at column 0, above `exec`: a block inside
 *     another `if` runs only when that one does, and one below `exec` never runs.
 *   server/test/runScriptEnv.test.ts runs the script itself over fixture options and compares the
 *   environment it hands to `exec` with what each reader expects.
 */

/** `schema:` keys → their schema strings (quotes stripped), in file order. */
export function schemaKeys(configText) {
  return parseBlock(configText, 'schema');
}
/** `options:` keys → their default scalars (quotes stripped). */
export function optionKeys(configText) {
  return parseBlock(configText, 'options');
}
function parseBlock(configText, name) {
  const i = configText.indexOf(`\n${name}:`);
  if (i < 0) throw new Error(`config.yaml has no ${name}: block`);
  const text = configText.slice(i + 1);
  const end = text.search(/\n[a-z]/);
  const out = new Map();
  for (const m of (end < 0 ? text : text.slice(0, end)).matchAll(/^  ([A-Z][A-Z0-9_]+):(.*)$/gm)) {
    let v = m[2].trim();
    const hash = v.indexOf(' #');
    if (hash >= 0) v = v.slice(0, hash).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

export const isOptionalSchema = (schema) => String(schema).replace(/"/g, '').trim().endsWith('?');

/** Keys declared in `schema:` with no `options:` default. */
export function schemaOnlyKeys(configText) {
  const opts = optionKeys(configText);
  return [...schemaKeys(configText).keys()].filter((k) => !opts.has(k));
}

const HAS_VALUE_FORM = (key) =>
  new RegExp(`^\\s*if bashio::config\\.has_value '${key}'; then export ${key}="\\$\\(bashio::config '${key}'\\)"; fi\\s*$`, 'm');

/** The canonical has_value line for a schema-only key (without indentation). */
export function hasValueLine(key) {
  return `if bashio::config.has_value '${key}'; then export ${key}="$(bashio::config '${key}')"; fi`;
}

/**
 * Every line of the run script that names `key` (as a whole word), comment lines excluded, apart from
 * ONE copy of its canonical has_value line: for a schema-only key, each of these is a second way the
 * key reaches the environment (or a second copy of the line). [] when the line stands alone.
 */
export function strayReferences(runText, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`);
  const canonical = hasValueLine(key);
  const out = [];
  let canonicalSeen = false;
  for (const line of runText.split('\n')) {
    if (/^\s*#/.test(line) || !word.test(line)) continue;
    if (line.trim() === canonical && !canonicalSeen) { canonicalSeen = true; continue; }
    out.push(line.trim());
  }
  return out;
}

/** Text with its quoted strings and its comment removed (for finding commands, not values). */
function codeOf(line) {
  return line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""').replace(/(^|\s)#.*$/, '$1');
}
const OPENERS = new Set(['if', 'case', 'for', 'while', 'until', 'select', '{']);
const CLOSERS = new Set(['fi', 'esac', 'done', '}']);
const CMD_BREAKS = new Set([';', '&&', '||', '|', 'then', 'else', 'elif', 'do', '(', '{']);

/**
 * Per line of `runText`: the shell nesting depth it starts at (0 = top level) and the line index of the
 * first `exec` at the top level (null when there is none). Comment lines and quoted text are skipped;
 * a one-line `if …; then …; fi` opens and closes on its own line. Enough for this script's shapes
 * (if/case/for/while blocks and brace groups), not a shell parser.
 */
export function scriptLayout(runText) {
  const lines = runText.split('\n');
  const depthAt = [];
  let depth = 0;
  let execLine = null;
  lines.forEach((line, i) => {
    depthAt.push(depth);
    if (/^\s*#/.test(line)) return;
    const tokens = codeOf(line).replace(/(;|&&|\|\||\|)/g, ' $1 ').trim().split(/\s+/).filter(Boolean);
    let atCommand = true;
    for (const t of tokens) {
      if (atCommand && OPENERS.has(t)) depth += 1;
      else if (atCommand && CLOSERS.has(t)) depth -= 1;
      else if (atCommand && t === 'exec' && depth === 0 && execLine == null) execLine = i;
      atCommand = CMD_BREAKS.has(t);
    }
  });
  return { depthAt, execLine };
}

/** Does `line` assign or export the variable `key`? (`KEY=…`, `export KEY=…`, `export KEY`, `declare -x KEY`.) */
export function assignsKey(line, key) {
  if (/^\s*#/.test(line)) return false;
  const code = codeOf(line);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^A-Za-z0-9_$])${esc}\\+?=`).test(code)) return true;
  if (new RegExp(`\\b(?:export|declare|typeset|readonly|local)\\s+(?:-\\w+\\s+)*(?:[A-Za-z_]\\w*(?:=\\S*)?\\s+)*${esc}(?![A-Za-z0-9_=])`).test(code)) return true;
  return false;
}

/**
 * The export block of a schema key: the line range [start, end] (inclusive) and its anchor line, or
 * null when the script has none. The block is the first line that is, indentation aside, the key's
 * form: the verbatim export line, the has_value line, or the `if bashio::config.true 'KEY'; then`
 * line through its `fi` (the first such block that exports the key). placementViolations then holds
 * its indentation, depth and position to the rule.
 */
export function exportBlockOf(runText, key) {
  const lines = runText.split('\n');
  const verbatim = `export ${key}="$(bashio::config '${key}')"`;
  const hasValue = hasValueLine(key);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === verbatim || t === hasValue) return { start: i, end: i, anchor: lines[i] };
    if (t === `if bashio::config.true '${key}'; then`) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== 'fi') end++;
      if (lines.slice(i + 1, end).some((l) => assignsKey(l, key))) return { start: i, end, anchor: lines[i] };
    }
  }
  return null;
}

/**
 * v1.191.0 (review 3) — where `key` is set, apart from its one export block: each line outside the
 * block that assigns or exports it (the later export wins in bash), and the block itself when it is
 * not at column 0 at the top level above `exec` (it would run only when another block does, or never).
 * [] when the key is exported once, in place.
 */
export function placementViolations(runText, key) {
  const block = exportBlockOf(runText, key);
  if (!block) return [];
  const out = [];
  const lines = runText.split('\n');
  lines.forEach((line, i) => {
    if (i >= block.start && i <= block.end) return;
    if (assignsKey(line, key)) out.push(`${key}: exported again outside its one export block (the later export wins): ${line.trim()}`);
  });
  const { depthAt, execLine } = scriptLayout(runText);
  if (/^\s/.test(block.anchor)) out.push(`${key}: its export block is indented; it must start at column 0, at the top level of the script: ${block.anchor.trim()}`);
  if (depthAt[block.start] !== 0) out.push(`${key}: its export block is inside another block, so it runs only when that one does: ${block.anchor.trim()}`);
  if (execLine != null && block.start > execLine) out.push(`${key}: its export block is below \`exec\`, so it never runs: ${block.anchor.trim()}`);
  return out;
}

/**
 * The convention the run script exports `key` with:
 *   '1/0' | 'true/false' | 'verbatim' | 'has_value' | 'none' | 'mixed'
 */
export function exportFormOf(runText, key) {
  const forms = new Set();
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (HAS_VALUE_FORM(esc).test(runText)) forms.add('has_value');
  // the unconditional verbatim export, outside a has_value guard
  const bare = new RegExp(`^export ${esc}="\\$\\(bashio::config '${esc}'\\)"\\s*$`, 'm');
  if (bare.test(runText)) forms.add('verbatim');
  // a bool block: `if bashio::config.true 'KEY'; then export KEY=X else export KEY=Y fi`
  const at = runText.indexOf(`bashio::config.true '${key}'`);
  if (at >= 0) {
    const body = runText.slice(at, runText.indexOf('\nfi', at));
    const vals = [...body.matchAll(new RegExp(`export ${esc}=(\\S+)`, 'g'))].map((m) => m[1]);
    const set = new Set(vals);
    if (set.has('1') && set.has('0') && set.size === 2) forms.add('1/0');
    else if (set.has('true') && set.has('false') && set.size === 2) forms.add('true/false');
    else if (vals.length) forms.add('mixed');
  }
  if (forms.size === 0) return 'none';
  if (forms.size > 1) return 'mixed';
  return [...forms][0];
}

/**
 * Every violation of the bridge rules for (config.yaml, run script, OPTIONS rows).
 * `rows` is a map name → { source, exportForm?, clamp? }.
 */
export function bridgeViolations(configText, runText, rows) {
  const out = [];
  const schema = schemaKeys(configText);
  const opts = optionKeys(configText);
  for (const [key, s] of schema) {
    const row = rows[key];
    if (!row) { out.push(`${key}: declared in schema: but has no OPTIONS row in config.ts`); continue; }
    if (row.source !== 'option') out.push(`${key}: its OPTIONS row is '${row.source}', not 'option', although config.yaml declares it`);
    const form = exportFormOf(runText, key);
    if (opts.has(key)) {
      if (form === 'none') out.push(`${key}: has an options: default but the run script never exports it (the option is inert)`);
      else if (form === 'has_value') out.push(`${key}: has an options: default but is exported under has_value — a default is always present, export it unconditionally`);
      else if (row.exportForm && form !== row.exportForm) out.push(`${key}: the run script exports it as ${form} but its reader expects ${row.exportForm} (the inverted-flag failure)`);
    } else {
      if (!isOptionalSchema(s)) out.push(`${key}: schema-only keys must be optional ('?'); ${s} is not`);
      if (form !== 'none' && form !== 'has_value') out.push(`${key}: a schema-only key may be exported only as if bashio::config.has_value 'KEY'; then export KEY="$(bashio::config 'KEY')"; fi — a bare export puts the string "null" into the environment when the field is cleared (found: ${form})`);
      if (form === 'has_value') {
        for (const line of strayReferences(runText, key)) {
          out.push(`${key}: a schema-only key may appear in the run script only on its one has_value line; this line also names it, and would export the string "null" when the field is cleared: ${line}`);
        }
      }
      if (form === 'none') out.push(`${key}: declared in schema: but the run script never exports it`);
    }
    // v1.191.0 (review 3) — every key: set in one place, and that place runs.
    out.push(...placementViolations(runText, key));
  }
  for (const [name, row] of Object.entries(rows)) {
    if (row.source === 'option' && !schema.has(name)) out.push(`${name}: OPTIONS row says 'option' but config.yaml does not declare it`);
  }
  // the run script may not export a key the schema does not declare
  for (const m of runText.matchAll(/bashio::config(?:\.true|\.has_value)?\s+'([A-Z][A-Z0-9_]+)'/g)) {
    if (!schema.has(m[1])) out.push(`${m[1]}: the run script reads it but config.yaml has no schema entry (an empty value at boot hides a typo)`);
  }
  return [...new Set(out)];
}
